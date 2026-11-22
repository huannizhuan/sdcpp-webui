// Shared fetch helpers. The existing api.ts keeps its own copies; new modules use
// these so prompt and history calls do not duplicate error handling.

export function withBase(baseUrl: string, path: string): string {
    const base = String(baseUrl || window.location.pathname).trim().replace(/\/+$/, "");
    return `${base}${path}`;
}

export async function fetchJsonWithBase<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    let payload: any = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }
    if (!response.ok) {
        throw new Error(
            (payload && (payload.error || payload.message)) || `HTTP ${response.status}`
        );
    }
    return payload as T;
}
