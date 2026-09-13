import type { APIRoute } from "astro";
import { loadGns3Topology } from "../../../components/network-diagram/gns3";

export const prerender = false;

const LIMITS = {
    minWidth: 640,
    maxWidth: 1600,
    defaultWidth: 1600,

    minHeight: 360,
    maxHeight: 1200,
    defaultHeight: 900,

    minScale: 0.5,
    maxScale: 2,
    defaultScale: 1,

    minZoom: 0.25,
    maxZoom: 3,
    defaultZoom: 1,

    minPadding: 0,
    maxPadding: 200,
    defaultPadding: 30,

    maxOutputPixels: 3_840_000,
    navigationTimeoutMs: 20_000,
    renderTimeoutMs: 20_000,
} as const;

const FOOTER = {
    height: 36,
    text: "Generated at blog.labforger.com",
} as const;

type DiagramTheme = "dark" | "light";

interface CloudflareRuntime {
    env?: {
        BROWSER?: unknown;
    };
}

interface LocalsWithRuntime {
    runtime?: CloudflareRuntime;
}

interface BrowserLike {
    newPage(): Promise<PageLike>;
    close(): Promise<void>;
}

interface PageLike {
    setViewport(options: {
        width: number;
        height: number;
        deviceScaleFactor?: number;
    }): Promise<void>;

    goto(
        url: string,
        options?: {
            waitUntil?:
                | "load"
                | "domcontentloaded"
                | "networkidle0"
                | "networkidle2";
            timeout?: number;
        },
    ): Promise<unknown>;

    waitForSelector(
        selector: string,
        options?: {
            timeout?: number;
            visible?: boolean;
        },
    ): Promise<unknown>;

    evaluate<
        Parameters extends unknown[],
        Result,
    >(
        callback: (...parameters: Parameters) => Result | Promise<Result>,
        ...parameters: Parameters
    ): Promise<Result>;

    emulateMediaFeatures?(
        features: Array<{
            name: string;
            value: string;
        }>,
    ): Promise<void>;

    screenshot(options?: {
        type?: "png" | "jpeg" | "webp";
        fullPage?: boolean;
        omitBackground?: boolean;
    }): Promise<Uint8Array>;
}

function readNumber(
    url: URL,
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const rawValue = url.searchParams.get(name);

    if (rawValue === null || rawValue.trim() === "") {
        return fallback;
    }

    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, parsed));
}

function readBoolean(
    url: URL,
    name: string,
    fallback: boolean,
): boolean {
    const value = url.searchParams.get(name)?.trim().toLowerCase();

    if (value === undefined) return fallback;

    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;

    return fallback;
}

function readTheme(
    url: URL,
    fallback: DiagramTheme = "dark",
): DiagramTheme {
    const value = url.searchParams.get("theme")?.trim().toLowerCase();

    if (value === "light" || value === "dark") {
        return value;
    }

    return fallback;
}

function isValidGistId(value: string | undefined): value is string {
    return typeof value === "string" && /^[a-f0-9]{5,64}$/i.test(value);
}

function getCloudflareBrowserBinding(locals: App.Locals): unknown {
    return (locals as App.Locals & LocalsWithRuntime)
        .runtime
        ?.env
        ?.BROWSER;
}

async function launchBrowser(
    locals: App.Locals,
): Promise<BrowserLike> {
    const cloudflareBinding = getCloudflareBrowserBinding(locals);

    if (cloudflareBinding) {
        const cloudflarePuppeteer = await import("@cloudflare/puppeteer");

        return await cloudflarePuppeteer.default.launch(
            cloudflareBinding as never,
        ) as unknown as BrowserLike;
    }

    const localPuppeteer = await import("puppeteer");

    return await localPuppeteer.default.launch({
        headless: true,
        args: [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
        ],
    }) as unknown as BrowserLike;
}

function errorResponse(
    message: string,
    status: number,
): Response {
    return new Response(message, {
        status,
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

async function validateProject(gistId: string): Promise<void> {
    try {
        await loadGns3Topology(`https://gist.github.com/${gistId}`);
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : "Invalid GNS3 project.";

        throw new Error(message);
    }
}

export const GET: APIRoute = async ({
                                        params,
                                        request,
                                        locals,
                                    }) => {
    const gistId = params.gistId;

    if (!isValidGistId(gistId)) {
        return errorResponse("Invalid Gist ID.", 400);
    }

    const requestUrl = new URL(request.url);

    const width = Math.round(
        readNumber(
            requestUrl,
            "w",
            LIMITS.defaultWidth,
            LIMITS.minWidth,
            LIMITS.maxWidth,
        ),
    );

    const height = Math.round(
        readNumber(
            requestUrl,
            "h",
            LIMITS.defaultHeight,
            LIMITS.minHeight,
            LIMITS.maxHeight,
        ),
    );

    const scale = readNumber(
        requestUrl,
        "scale",
        LIMITS.defaultScale,
        LIMITS.minScale,
        LIMITS.maxScale,
    );

    const zoom = readNumber(
        requestUrl,
        "zoom",
        LIMITS.defaultZoom,
        LIMITS.minZoom,
        LIMITS.maxZoom,
    );

    const padding = Math.round(
        readNumber(
            requestUrl,
            "padding",
            LIMITS.defaultPadding,
            LIMITS.minPadding,
            LIMITS.maxPadding,
        ),
    );

    const shouldFit = readBoolean(
        requestUrl,
        "fit",
        true,
    );

    const theme = readTheme(
        requestUrl,
        "dark",
    );

    const outputWidth = width * scale;
    const outputHeight = height * scale;
    const outputPixels = outputWidth * outputHeight;

    if (outputPixels > LIMITS.maxOutputPixels) {
        return errorResponse(
            `Requested image is too large. Maximum output is ${LIMITS.maxOutputPixels.toLocaleString()} pixels.`,
            400,
        );
    }

    /*
     * Validate before launching Chromium.
     * This prevents invalid/non-GNS3 Gists from triggering slow image work.
     */
    try {
        await validateProject(gistId);
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : "Invalid GNS3 project.";

        return errorResponse(
            `Could not render the network diagram: ${message}`,
            400,
        );
    }

    let browser: BrowserLike | undefined;

    try {
        browser = await launchBrowser(locals);

        const page = await browser.newPage();

        await page.setViewport({
            width,
            height,
            deviceScaleFactor: scale,
        });

        if (page.emulateMediaFeatures) {
            await page.emulateMediaFeatures([
                {
                    name: "prefers-color-scheme",
                    value: theme,
                },
            ]);
        }

        const viewerUrl = new URL(
            `/network/${encodeURIComponent(gistId)}`,
            requestUrl.origin,
        );

        viewerUrl.searchParams.set("capture", "1");
        viewerUrl.searchParams.set("zoom", String(zoom));
        viewerUrl.searchParams.set("padding", String(padding));
        viewerUrl.searchParams.set("fit", shouldFit ? "1" : "0");
        viewerUrl.searchParams.set("theme", theme);

        await page.goto(viewerUrl.href, {
            waitUntil: "networkidle0",
            timeout: LIMITS.navigationTimeoutMs,
        });

        await page.waitForSelector(
            '[data-network-diagram][data-graph-ready="true"]',
            {
                visible: true,
                timeout: LIMITS.renderTimeoutMs,
            },
        );

        await page.evaluate(
            (
                requestedZoom: number,
                requestedPadding: number,
                fitDiagram: boolean,
                requestedTheme: string,
                footerHeight: number,
                footerText: string,
            ) => {
                document.querySelector("astro-dev-toolbar")?.remove();

                document.documentElement.dataset.theme = requestedTheme;
                document.documentElement.style.colorScheme = requestedTheme;

                if (document.body) {
                    document.body.dataset.theme = requestedTheme;
                    document.body.style.colorScheme = requestedTheme;
                    document.body.style.overflow = "hidden";
                    document.body.style.margin = "0";
                }

                const footerId = "network-capture-footer";
                let footer = document.getElementById(footerId);

                if (!footer) {
                    footer = document.createElement("div");
                    footer.id = footerId;
                    document.body.append(footer);
                }

                footer.textContent = footerText;

                const isDark = requestedTheme === "dark";

                Object.assign(footer.style, {
                    position: "fixed",
                    left: "0",
                    right: "0",
                    bottom: "0",
                    height: `${footerHeight}px`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 16px",
                    fontFamily:
                        'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                    fontSize: "13px",
                    fontWeight: "500",
                    letterSpacing: "0.01em",
                    color: isDark ? "#94a3b8" : "#475569",
                    background: isDark ? "#0b1220" : "#f8fafc",
                    borderTop: isDark
                        ? "1px solid rgba(148, 163, 184, 0.22)"
                        : "1px solid rgba(15, 23, 42, 0.12)",
                    zIndex: "9999",
                    pointerEvents: "none",
                    boxSizing: "border-box",
                });

                const main = document.querySelector<HTMLElement>("main");
                const diagram = document.querySelector<HTMLElement>(
                    '[data-network-diagram]',
                );
                const body = document.querySelector<HTMLElement>(
                    "[data-diagram-body]",
                );
                const canvas = document.querySelector<HTMLElement>(
                    ".network-diagram__canvas",
                );

                if (main) {
                    main.style.height = `calc(100vh - ${footerHeight}px)`;
                }

                if (diagram) {
                    diagram.style.height = `calc(100vh - ${footerHeight}px)`;
                    diagram.style.borderRadius = "0";
                    diagram.style.border = "0";
                }

                if (body) {
                    body.style.height = `calc(100vh - ${footerHeight}px)`;
                    body.style.maxHeight = "none";
                }

                if (canvas) {
                    canvas.style.height = "100%";
                }

                const cytoscapeInstance = (
                    diagram as (
                        HTMLElement & {
                        cytoscapeInstance?: {
                            fit(
                                elements?: unknown,
                                padding?: number,
                            ): void;
                            zoom(): number;
                            zoom(value: number): void;
                            center(): void;
                            resize(): void;
                            style?(): {
                                update(): void;
                            };
                        };
                    }
                        ) | null
                )?.cytoscapeInstance;

                if (!cytoscapeInstance) {
                    throw new Error(
                        "The Cytoscape instance was not exposed by the diagram.",
                    );
                }

                cytoscapeInstance.resize();
                cytoscapeInstance.style?.().update();

                if (fitDiagram) {
                    cytoscapeInstance.fit(undefined, requestedPadding);
                }

                if (requestedZoom !== 1) {
                    cytoscapeInstance.zoom(
                        cytoscapeInstance.zoom() * requestedZoom,
                    );
                }

                cytoscapeInstance.center();

                document.documentElement.dataset.captureReady = "true";
            },
            zoom,
            padding,
            shouldFit,
            theme,
            FOOTER.height,
            FOOTER.text,
        );

        await page.waitForSelector(
            'html[data-capture-ready="true"]',
            {
                timeout: LIMITS.renderTimeoutMs,
            },
        );

        const image = await page.screenshot({
            type: "png",
            fullPage: false,
            omitBackground: false,
        });

        return new Response(image, {
            status: 200,
            headers: {
                "Content-Type": "image/png",
                "Cache-Control":
                    "public, max-age=3600, stale-while-revalidate=86400",
                "X-Content-Type-Options": "nosniff",
                "Vary": "Accept",
            },
        });
    } catch (error) {
        console.error("Could not render network image:", error);

        const message = error instanceof Error
            ? error.message
            : "Unknown rendering error.";

        return errorResponse(
            `Could not render the network diagram: ${message}`,
            500,
        );
    } finally {
        if (browser) {
            await browser.close().catch((error: unknown) => {
                console.error("Could not close screenshot browser:", error);
            });
        }
    }
};