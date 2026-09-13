import type { ElementDefinition } from "cytoscape";

export type NetworkNodeType =
    | "router"
    | "switch"
    | "firewall"
    | "server"
    | "computer"
    | "cloud"
    | "nat"
    | "atm_switch"
    | "hub"
    | "frsw"
    | "unknown";

export interface PortMapping {
    ethertype?: string;
    name?: string;
    port_number?: number;
    type?: string;
    vlan?: number;
}

export interface NodeProperties {
    ports_mapping?: PortMapping[];
    [key: string]: unknown;
}

export interface NetworkNode {
    data: {
        id: string;
        label: string;
        type: NetworkNodeType;
        model?: string;
        managementIp?: string;
        description?: string;
        properties?: NodeProperties;
        renderZ?: number;
    };
    position: {
        x: number;
        y: number;
        z?: number;
    };
}

export interface NetworkEdge {
    data: {
        id: string;
        source: string;
        target: string;
        sourceInterface?: string;
        targetInterface?: string;
        renderZ?: number;
    };
}

export interface NetworkDrawing {
    data: {
        id: string;
        rotation?: number;
        svg: string;
        x: number;
        y: number;
        z?: number;
    };
}

export interface NormalisedTopology {
    nodes: NetworkNode[];
    edges: NetworkEdge[];
    drawings: NetworkDrawing[];
}

export interface PreparedTopology {
    nodes: ElementDefinition[];
    edges: ElementDefinition[];
    drawingElements: ElementDefinition[];
}
