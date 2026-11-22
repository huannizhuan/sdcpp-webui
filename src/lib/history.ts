import { fetchJsonWithBase, withBase } from "./http";

export interface HistoryEntry {
    id: string;
    file: string;
    prompt: string;
    negative_prompt: string;
    model_name: string;
    model_family: string;
    seed: number;
    width: number;
    height: number;
    created_at: number;
    has_thumbnail: boolean;
}

export interface HistoryListResponse {
    items: HistoryEntry[];
    total: number;
    limit: number;
    offset: number;
    directory: string;
    writable: boolean;
}

export interface HistoryThumbnailResponse {
    id: string;
    width: number;
    height: number;
    format: string;
    b64_json: string;
}

export function getHistory(baseUrl: string, limit = 20, offset = 0): Promise<HistoryListResponse> {
    return fetchJsonWithBase<HistoryListResponse>(
        withBase(baseUrl, `/sdcpp/v1/history?limit=${limit}&offset=${offset}`)
    );
}

export function getHistoryThumbnail(baseUrl: string, id: string): Promise<HistoryThumbnailResponse> {
    return fetchJsonWithBase<HistoryThumbnailResponse>(
        withBase(baseUrl, `/sdcpp/v1/history/${encodeURIComponent(id)}/thumbnail`)
    );
}

export function deleteHistoryEntry(baseUrl: string, id: string): Promise<{ deleted: string }> {
    return fetchJsonWithBase<{ deleted: string }>(
        withBase(baseUrl, `/sdcpp/v1/history/${encodeURIComponent(id)}`),
        { method: "DELETE" }
    );
}
