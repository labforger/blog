import type {
    NetworkDrawing,
    NetworkEdge,
    NetworkNode,
    NetworkNodeType,
    NodeProperties,
    NormalisedTopology,
    PortMapping,
} from "./types";

const DEFAULT_GRID_SIZE = 75;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 5_000;
const MAX_LINKS = 20_000;
const MAX_DRAWINGS = 5_000;

interface GNS3Project {
    grid_size?: number;
    name?: string;
    topology?: {
        nodes?: unknown[];
        links?: unknown[];
        drawings?: unknown[];
    };
}

type PlainObject = Record<string, unknown>;

const GIST_HOSTS = new Set(["gist.github.com", "www.gist.github.com"]);

function resolveProjectSource(src: string): string {
    const sourceUrl = /^https?:\/\//i.test(src)
        ? new URL(src)
        : new URL(
            src,
            typeof window !== "undefined"
                ? window.location.href
                : "http://localhost/",
        );

    if (!GIST_HOSTS.has(sourceUrl.hostname.toLowerCase())) {
        return sourceUrl.href;
    }

    const pathParts = sourceUrl.pathname
        .split("/")
        .filter(Boolean);

    const gistId = pathParts.at(-1);

    if (!gistId || !/^[a-f0-9]{5,64}$/i.test(gistId)) {
        throw new TypeError(
            "The GitHub Gist URL does not contain a valid Gist ID.",
        );
    }

    return `https://gist.githubusercontent.com/raw/${gistId}/`;
}

function isPlainObject(value: unknown): value is PlainObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}

function asPositiveInteger(value: unknown, fallback: number): number {
    const number = asFiniteNumber(value, fallback);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function parseProjectJson(text: string): GNS3Project {
    const parsed: unknown = JSON.parse(text);

    if (!isPlainObject(parsed)) {
        throw new TypeError("The GNS3 project must contain a JSON object.");
    }

    const topology = parsed.topology;

    if (!isPlainObject(topology)) {
        throw new TypeError("The file does not contain a GNS3 topology.");
    }

    if (
        !Array.isArray(topology.nodes) ||
        !Array.isArray(topology.links)
    ) {
        throw new TypeError(
            "The GNS3 topology is missing nodes or links.",
        );
    }

    const looksLikeGns3 =
        typeof parsed.name === "string" ||
        typeof parsed.project_id === "string" ||
        typeof parsed.version === "string" ||
        typeof parsed.grid_size === "number";

    if (!looksLikeGns3) {
        throw new TypeError(
            "The file does not appear to be a GNS3 project.",
        );
    }

    return parsed as GNS3Project;
}

function inferNodeType(nodeTypeValue: unknown, symbolValue: unknown): NetworkNodeType {
    const nodeType = asString(nodeTypeValue).toLowerCase();
    const symbol = asString(symbolValue).toLowerCase();

    if (nodeType === "cloud") return "cloud";
    if (nodeType === "nat") return "nat";
    if (nodeType === "atm_switch") return "atm_switch";
    if (nodeType === "ethernet_hub" || symbol.includes("hub")) return "hub";
    if (nodeType === "frame_relay_switch") return "frsw";
    if (nodeType === "router" || symbol.includes("router")) return "router";
    if (nodeType === "ethernet_switch" || symbol.includes("switch")) return "switch";
    if (symbol.includes("firewall")) return "firewall";
    if (symbol.includes("server")) return "server";
    if (
        nodeType === "vpcs" ||
        nodeType === "qemu" ||
        symbol.includes("client") ||
        symbol.includes("guest")
    ) {
        return "computer";
    }

    return "unknown";
}

function inferModel(nodeTypeValue: unknown, properties: PlainObject): string {
    const nodeType = asString(nodeTypeValue);
    const builtInModels: Readonly<Record<string, string>> = {
        ethernet_switch: "GNS3 Ethernet switch",
        atm_switch: "GNS3 ATM switch",
        cloud: "GNS3 Cloud node",
        ethernet_hub: "GNS3 Ethernet hub",
        frame_relay_switch: "GNS3 Frame Relay switch",
        nat: "GNS3 NAT node",
        vpcs: "VPCS",
    };

    if (builtInModels[nodeType]) return builtInModels[nodeType];

    const diskImage = properties.hda_disk_image;
    if (typeof diskImage === "string" && diskImage) {
        const filename = diskImage.split(/[\\/]/).pop() ?? diskImage;
        return filename.replace(/\.(?:img|iso|qcow2?|vmdk)$/i, "");
    }

    return nodeType.replaceAll("_", " ") || "Unknown";
}

function cleanPortMappings(value: unknown): PortMapping[] | undefined {
    if (!Array.isArray(value)) return undefined;

    const ports = value
        .filter(isPlainObject)
        .map((port) => ({
            ethertype: typeof port.ethertype === "string" ? port.ethertype : undefined,
            name: typeof port.name === "string" ? port.name : undefined,
            port_number: typeof port.port_number === "number" ? port.port_number : undefined,
            type: typeof port.type === "string" ? port.type : undefined,
            vlan: typeof port.vlan === "number" ? port.vlan : undefined,
        }));

    return ports.length > 0 ? ports : undefined;
}

function cleanProperties(properties: PlainObject): NodeProperties {
    const cleaned: NodeProperties = {};

    if (typeof properties.platform === "string" && properties.platform) {
        cleaned.Platform = properties.platform;
    }
    if (typeof properties.cpus === "number") cleaned.vCPUs = properties.cpus;
    if (typeof properties.ram === "number") cleaned.Memory = `${properties.ram} MB`;
    if (typeof properties.adapter_type === "string" && properties.adapter_type) {
        cleaned["Adapter type"] = properties.adapter_type;
    }
    if (typeof properties.adapters === "number") {
        cleaned["Network adapters"] = properties.adapters;
    }

    const ports = cleanPortMappings(properties.ports_mapping);
    if (ports) cleaned.ports_mapping = ports;

    return cleaned;
}

function normalisePosition(node: PlainObject, gridSize: number): NetworkNode["position"] {
    const centreX = asFiniteNumber(node.x) + asFiniteNumber(node.width) / 2;
    const centreY = asFiniteNumber(node.y) + asFiniteNumber(node.height) / 2;

    return {
        x: Math.round(centreX / gridSize) * gridSize,
        y: Math.round(centreY / gridSize) * gridSize,
        z: asFiniteNumber(node.z, 1),
    };
}

function normaliseNode(rawNode: unknown, gridSize: number): NetworkNode {
    if (!isPlainObject(rawNode)) {
        throw new TypeError("A GNS3 node is not an object.");
    }

    const nodeId = asString(rawNode.node_id);
    if (!nodeId) throw new TypeError("A GNS3 node is missing node_id.");

    const name = asString(rawNode.name, nodeId);
    const labelObject = isPlainObject(rawNode.label) ? rawNode.label : undefined;
    const label = asString(labelObject?.text, name) || "Unnamed node";
    const rawProperties = isPlainObject(rawNode.properties) ? rawNode.properties : {};

    return {
        data: {
            id: name,
            label,
            type: inferNodeType(rawNode.node_type, rawNode.symbol),
            model: inferModel(rawNode.node_type, rawProperties),
            description: "",
            properties: cleanProperties(rawProperties),
        },
        position: normalisePosition(rawNode, gridSize),
    };
}

interface NodeLookupEntry {
    cytoscapeId: string;
    portNameFormat: string;
}

function formatInterface(format: string, portNumber: number): string {
    if (!format) return String(portNumber);
    return format.includes("{0}")
        ? format.replaceAll("{0}", String(portNumber))
        : `${format}${portNumber}`;
}

function normaliseEdge(rawLink: unknown, lookup: Map<string, NodeLookupEntry>): NetworkEdge {
    if (!isPlainObject(rawLink) || !Array.isArray(rawLink.nodes) || rawLink.nodes.length < 2) {
        throw new TypeError("A GNS3 link has an invalid shape.");
    }

    const source = rawLink.nodes[0];
    const target = rawLink.nodes[1];
    if (!isPlainObject(source) || !isPlainObject(target)) {
        throw new TypeError("A GNS3 link endpoint has an invalid shape.");
    }

    const sourceNode = lookup.get(asString(source.node_id));
    const targetNode = lookup.get(asString(target.node_id));
    if (!sourceNode || !targetNode) {
        throw new TypeError("A GNS3 link references an unknown node.");
    }

    const linkId = asString(rawLink.link_id);
    if (!linkId) throw new TypeError("A GNS3 link is missing link_id.");

    const sourcePort = asFiniteNumber(source.port_number);
    const targetPort = asFiniteNumber(target.port_number);

    return {
        data: {
            id: linkId,
            source: sourceNode.cytoscapeId,
            target: targetNode.cytoscapeId,
            sourceInterface: formatInterface(sourceNode.portNameFormat, sourcePort),
            targetInterface: formatInterface(targetNode.portNameFormat, targetPort),
        },
    };
}

function normaliseDrawing(rawDrawing: unknown): NetworkDrawing {
    if (!isPlainObject(rawDrawing)) {
        throw new TypeError("A GNS3 drawing is not an object.");
    }

    const id = asString(rawDrawing.drawing_id);
    const svg = asString(rawDrawing.svg);
    if (!id || !svg) throw new TypeError("A GNS3 drawing is missing its ID or SVG.");

    return {
        data: {
            id,
            rotation: asFiniteNumber(rawDrawing.rotation),
            svg,
            x: asFiniteNumber(rawDrawing.x),
            y: asFiniteNumber(rawDrawing.y),
            z: asFiniteNumber(rawDrawing.z),
        },
    };
}

export function normaliseGns3Project(project: GNS3Project): NormalisedTopology {
    const topology = project.topology;
    if (!topology || !Array.isArray(topology.nodes) || !Array.isArray(topology.links)) {
        throw new TypeError("The GNS3 project does not contain a valid topology.");
    }

    const drawings = Array.isArray(topology.drawings) ? topology.drawings : [];
    if (topology.nodes.length > MAX_NODES) throw new RangeError("The project has too many nodes.");
    if (topology.links.length > MAX_LINKS) throw new RangeError("The project has too many links.");
    if (drawings.length > MAX_DRAWINGS) throw new RangeError("The project has too many drawings.");

    const gridSize = asPositiveInteger(project.grid_size, DEFAULT_GRID_SIZE);
    const nodes = topology.nodes.map((node) => normaliseNode(node, gridSize));
    const lookup = new Map<string, NodeLookupEntry>();

    topology.nodes.forEach((rawNode, index) => {
        if (!isPlainObject(rawNode)) return;
        const gns3Id = asString(rawNode.node_id);
        if (!gns3Id) return;
        lookup.set(gns3Id, {
            cytoscapeId: nodes[index].data.id,
            portNameFormat: asString(rawNode.port_name_format),
        });
    });

    return {
        nodes,
        edges: topology.links.map((link) => normaliseEdge(link, lookup)),
        drawings: drawings.map(normaliseDrawing),
    };
}

export async function loadGns3Topology(src: string): Promise<NormalisedTopology> {
    const resolvedSource = resolveProjectSource(src);
    const response = await fetch(resolvedSource, { credentials: "omit" });
    if (!response.ok) {
        throw new Error(`Could not load GNS3 project (${response.status} ${response.statusText}).`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
        throw new RangeError("The GNS3 project is too large to render.");
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_SOURCE_BYTES) {
        throw new RangeError("The GNS3 project is too large to render.");
    }

    const project = parseProjectJson(new TextDecoder().decode(buffer));
    return normaliseGns3Project(project);
}
