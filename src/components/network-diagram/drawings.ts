import type { NetworkDrawing } from "./types";

export interface PreparedDrawingElement {
    group: "nodes" | "edges";
    data: Record<string, string | number>;
    position?: { x: number; y: number };
    classes: string;
    locked?: boolean;
    selectable?: boolean;
    grabbable?: boolean;
}

function parseSvgNumber(value: string | undefined, fallback = 0): number {
    if (!value) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function readSvgAttribute(source: string, name: string): string | undefined {
    const match = source.match(
        new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"),
    );
    return match?.[1];
}

function readSvgStyleProperty(source: string, name: string): string | undefined {
    const style = readSvgAttribute(source, "style");
    if (!style) return undefined;

    for (const declaration of style.split(";")) {
        const separator = declaration.indexOf(":");
        if (separator < 0) continue;

        const property = declaration.slice(0, separator).trim().toLowerCase();
        if (property !== name.toLowerCase()) continue;

        const value = declaration.slice(separator + 1).trim();
        return value || undefined;
    }

    return undefined;
}

function readSvgPresentationAttribute(
    element: string,
    outerSvg: string,
    name: string,
): string | undefined {
    return (
        readSvgAttribute(element, name) ??
        readSvgStyleProperty(element, name) ??
        readSvgAttribute(outerSvg, name) ??
        readSvgStyleProperty(outerSvg, name)
    );
}

function rotateDrawingPoint(
    x: number,
    y: number,
    centreX: number,
    centreY: number,
    degrees: number,
): { x: number; y: number } {
    if (degrees === 0) return { x, y };
    const radians = degrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const offsetX = x - centreX;
    const offsetY = y - centreY;
    return {
        x: centreX + offsetX * cosine - offsetY * sine,
        y: centreY + offsetX * sine + offsetY * cosine,
    };
}

const Z_BAND_SIZE = 100_000;
const NETWORK_EDGE_OFFSET = 500;
const NETWORK_NODE_OFFSET = 1_000;
const DRAWING_ORDER_OFFSET = 10_000;
const DRAWING_ORDER_STEP = 100;

export function prepareDrawingElements(
    sourceDrawings: NetworkDrawing[],
): PreparedDrawingElement[] {
    const prepared: PreparedDrawingElement[] = [];

    const addAnchor = (
        id: string,
        x: number,
        y: number,
        z: number,
        renderZ: number,
    ): void => {
        prepared.push({
            group: "nodes",
            data: { id, drawingType: "anchor", z, renderZ },
            position: { x, y },
            classes: "drawing drawing-anchor",
            locked: true,
            selectable: false,
            grabbable: false,
        });
    };

    const addEdge = (
        id: string,
        source: string,
        target: string,
        strokeWidth: number,
        stroke: string,
        strokeOpacity: number,
        z: number,
        renderZ: number,
    ): void => {
        prepared.push({
            group: "edges",
            data: {
                id,
                source,
                target,
                drawingType: "line",
                strokeWidth,
                originalStroke: stroke,
                strokeOpacity,
                z,
                renderZ,
            },
            classes: "drawing drawing-line",
            selectable: false,
        });
    };

    const orderedDrawings = [...sourceDrawings].sort(
        (left, right) => (left.data.z ?? 0) - (right.data.z ?? 0),
    );

    for (const [drawingOrder, drawing] of orderedDrawings.entries()) {
        const svg = drawing.data.svg;
        const openingSvg = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
        const width = parseSvgNumber(readSvgAttribute(openingSvg, "width"));
        const height = parseSvgNumber(readSvgAttribute(openingSvg, "height"));
        const originX = drawing.data.x;
        const originY = drawing.data.y;
        const centreX = originX + width / 2;
        const centreY = originY + height / 2;
        const rotation = drawing.data.rotation ?? 0;
        const z = drawing.data.z ?? 0;
        const itemRenderZ =
            z * Z_BAND_SIZE +
            DRAWING_ORDER_OFFSET +
            drawingOrder * DRAWING_ORDER_STEP;
        let sequence = 0;

        const absolutePoint = (x: number, y: number) =>
            rotateDrawingPoint(
                originX + x,
                originY + y,
                centreX,
                centreY,
                rotation,
            );

        const addPath = (
            baseId: string,
            points: Array<{ x: number; y: number }>,
            closed: boolean,
            strokeWidth: number,
            stroke: string,
            strokeOpacity: number,
        ): void => {
            if (points.length < 2) return;
            const anchorIds = points.map((point, index) => {
                const transformed = absolutePoint(point.x, point.y);
                const anchorId = `${baseId}-point-${index}`;
                addAnchor(
                    anchorId,
                    transformed.x,
                    transformed.y,
                    z,
                    itemRenderZ,
                );
                return anchorId;
            });
            const segmentCount = closed ? anchorIds.length : anchorIds.length - 1;
            for (let index = 0; index < segmentCount; index += 1) {
                addEdge(
                    `${baseId}-segment-${index}`,
                    anchorIds[index],
                    anchorIds[(index + 1) % anchorIds.length],
                    strokeWidth,
                    stroke,
                    strokeOpacity,
                    z,
                    itemRenderZ + 1,
                );
            }
        };

        for (const match of svg.matchAll(/<(rect|line|polyline|polygon|ellipse|circle)\b[^>]*\/?>/gi)) {
            const tag = match[1].toLowerCase();
            const element = match[0];
            const baseId = `drawing-${drawing.data.id}-${sequence++}`;
            const elementOpacity = Math.min(
                1,
                Math.max(
                    0,
                    parseSvgNumber(
                        readSvgPresentationAttribute(
                            element,
                            openingSvg,
                            "opacity",
                        ),
                        1,
                    ),
                ),
            );
            const strokeWidth = Math.max(
                0.5,
                parseSvgNumber(
                    readSvgPresentationAttribute(
                        element,
                        openingSvg,
                        "stroke-width",
                    ),
                    2,
                ),
            );
            const stroke =
                readSvgPresentationAttribute(element, openingSvg, "stroke") ??
                "#ffffff";
            const strokeOpacity = Math.min(
                1,
                Math.max(
                    0,
                    parseSvgNumber(
                        readSvgPresentationAttribute(
                            element,
                            openingSvg,
                            "stroke-opacity",
                        ),
                        1,
                    ) * elementOpacity,
                ),
            );

            if (tag === "rect") {
                const x = parseSvgNumber(readSvgAttribute(element, "x"));
                const y = parseSvgNumber(readSvgAttribute(element, "y"));
                const rectWidth = parseSvgNumber(readSvgAttribute(element, "width"));
                const rectHeight = parseSvgNumber(readSvgAttribute(element, "height"));
                const fill =
                    readSvgPresentationAttribute(element, openingSvg, "fill") ??
                    "none";
                const fillOpacity = Math.min(
                    1,
                    Math.max(
                        0,
                        parseSvgNumber(
                            readSvgPresentationAttribute(
                                element,
                                openingSvg,
                                "fill-opacity",
                            ),
                            1,
                        ) * elementOpacity,
                    ),
                );

                if (rectWidth > 0 && rectHeight > 0) {
                    const shapeCentre = absolutePoint(
                        x + rectWidth / 2,
                        y + rectHeight / 2,
                    );

                    prepared.push({
                        group: "nodes",
                        data: {
                            id: `${baseId}-shape`,
                            drawingType: "shape",
                            shapeKind: "rectangle",
                            originalFill: fill,
                            fillOpacity:
                                fill.toLowerCase() === "none" || fill === "#"
                                    ? 0
                                    : fillOpacity,
                            originalStroke: stroke,
                            strokeOpacity,
                            strokeWidth,
                            drawingWidth: rectWidth,
                            drawingHeight: rectHeight,
                            z,
                            renderZ: itemRenderZ + sequence,
                        },
                        position: shapeCentre,
                        classes: "drawing drawing-shape drawing-rectangle",
                        locked: true,
                        selectable: false,
                        grabbable: false,
                    });
                }
                continue;
            }

            if (tag === "ellipse" || tag === "circle") {
                const cx = parseSvgNumber(readSvgAttribute(element, "cx"));
                const cy = parseSvgNumber(readSvgAttribute(element, "cy"));
                const radius = parseSvgNumber(readSvgAttribute(element, "r"));
                const rx = tag === "circle"
                    ? radius
                    : parseSvgNumber(readSvgAttribute(element, "rx"));
                const ry = tag === "circle"
                    ? radius
                    : parseSvgNumber(readSvgAttribute(element, "ry"));
                const fill =
                    readSvgPresentationAttribute(element, openingSvg, "fill") ??
                    "none";
                const fillOpacity = Math.min(
                    1,
                    Math.max(
                        0,
                        parseSvgNumber(
                            readSvgPresentationAttribute(
                                element,
                                openingSvg,
                                "fill-opacity",
                            ),
                            1,
                        ) * elementOpacity,
                    ),
                );
                const shapeCentre = absolutePoint(cx, cy);

                if (rx > 0 && ry > 0) {
                    prepared.push({
                        group: "nodes",
                        data: {
                            id: `${baseId}-shape`,
                            drawingType: "shape",
                            shapeKind: "ellipse",
                            originalFill: fill,
                            fillOpacity:
                                fill.toLowerCase() === "none" || fill === "#"
                                    ? 0
                                    : fillOpacity,
                            originalStroke: stroke,
                            strokeOpacity,
                            strokeWidth,
                            drawingWidth: rx * 2,
                            drawingHeight: ry * 2,
                            z,
                            renderZ: itemRenderZ + sequence,
                        },
                        position: shapeCentre,
                        classes: "drawing drawing-shape drawing-ellipse",
                        locked: true,
                        selectable: false,
                        grabbable: false,
                    });
                }
                continue;
            }

            if (tag === "line") {
                addPath(baseId, [
                    {
                        x: parseSvgNumber(readSvgAttribute(element, "x1")),
                        y: parseSvgNumber(readSvgAttribute(element, "y1")),
                    },
                    {
                        x: parseSvgNumber(readSvgAttribute(element, "x2")),
                        y: parseSvgNumber(readSvgAttribute(element, "y2")),
                    },
                ], false, strokeWidth, stroke, strokeOpacity);
                continue;
            }

            const values = (readSvgAttribute(element, "points") ?? "")
                .trim()
                .split(/[\s,]+/)
                .map(Number)
                .filter(Number.isFinite);
            const points: Array<{ x: number; y: number }> = [];
            for (let index = 0; index + 1 < values.length; index += 2) {
                points.push({ x: values[index], y: values[index + 1] });
            }
            addPath(
                baseId,
                points,
                tag === "polygon",
                strokeWidth,
                stroke,
                strokeOpacity,
            );
        }

        for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
            const attributes = match[1];
            const label = match[2].replace(/<[^>]+>/g, "").trim();
            if (!label) continue;
            const textX = parseSvgNumber(readSvgAttribute(attributes, "x"));
            const textY = parseSvgNumber(readSvgAttribute(attributes, "y"));
            const sourceFontSize = Math.max(
                1,
                parseSvgNumber(
                    readSvgAttribute(attributes, "font-size"),
                    10,
                ),
            );
            const textWidth = Math.max(1, width);
            const textHeight = Math.max(1, height);
            const position = absolutePoint(
                textX + textWidth / 2 + sourceFontSize,
                textY + textHeight / 2,
            );
            prepared.push({
                group: "nodes",
                data: {
                    id: `drawing-${drawing.data.id}-${sequence++}`,
                    drawingType: "text",
                    label,
                    fontSize: sourceFontSize * 1.6,
                    fontWeight: readSvgPresentationAttribute(attributes, openingSvg, "font-weight") ?? "normal",
                    originalColor: readSvgPresentationAttribute(attributes, openingSvg, "fill") ?? "#ffffff",
                    textOpacity: Math.min(
                        1,
                        Math.max(
                            0,
                            parseSvgNumber(
                                readSvgPresentationAttribute(
                                    attributes,
                                    openingSvg,
                                    "fill-opacity",
                                ),
                                1,
                            ),
                        ),
                    ),
                    drawingWidth: textWidth,
                    drawingHeight: textHeight,
                    z,
                    renderZ: itemRenderZ + sequence,
                },
                position,
                classes: "drawing drawing-text",
                locked: true,
                selectable: false,
                grabbable: false,
            });
        }
    }
    return prepared;
}

