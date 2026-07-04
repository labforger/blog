type Citation = Record<string, any>;

let nextNumber = 0;
const signatureToNumber = new Map<string, number>();
const numberToCitation = new Map<number, Citation>();

export function resetCitations() {
    nextNumber = 0;
    signatureToNumber.clear();
    numberToCitation.clear();
}

function signatureOf(fields: Citation) {
    const { pin, ...core } = fields; // exclude pin from identity

    const keys = Object.keys(core).sort();
    const stable: Record<string, any> = {};
    for (const k of keys) stable[k] = core[k];

    return JSON.stringify(stable);
}

export function cite(fields: Citation) {
    const sig = signatureOf(fields);

    const existing = signatureToNumber.get(sig);
    if (existing) return existing;

    nextNumber += 1;

    signatureToNumber.set(sig, nextNumber);
    numberToCitation.set(nextNumber, fields);

    return nextNumber;
}

export function getAllCitations() {
    return Array.from(numberToCitation.entries())
        .sort(([a], [b]) => a - b)
        .map(([number, citation]) => ({ number, citation }));
}