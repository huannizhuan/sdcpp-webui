import { fetchJsonWithBase, withBase } from "./http";

export type PromptMode = "fast" | "smart";

export interface PromptSpec {
    task: string;
    subject: string;
    appearance: string[];
    pose: string;
    composition: string;
    background: string;
    style: string;
    positive_prompt: string;
    negative_prompt: string;
    notes: string[];
    source_input: string;
}

export interface PromptBuildResponse {
    spec: PromptSpec;
    positive_prompt: string;
    negative_prompt: string;
    model_family: string;
    mode: PromptMode;
    notes: string[];
    elapsed_ms: number;
    llm_used: boolean;
    fallback_reason: string;
}

export interface PromptRefineResponse {
    spec: PromptSpec;
    positive_prompt: string;
    negative_prompt: string;
    model_family: string;
    instruction: string;
    notes: string[];
    changed: boolean;
}

export interface PromptLlmStatus {
    backend: string;
    configured: boolean;
    available: boolean;
    loaded: boolean;
    busy?: boolean;
    reason: string;
    port: number;
    load_ms: number;
    modes: string[];
    model_path_configured: boolean;
    vision_configured: boolean;
    binary_configured: boolean;
}

export interface ModelCapabilitiesResponse {
    model_family: string;
    model_name: string;
    model_version: string;
    capabilities: {
        text_to_image: boolean;
        negative_prompt: boolean;
        negative_prompt_effective: boolean;
        lora: boolean;
        img2img: boolean;
        // Legacy server flag; the editor uses edit_mode instead.
        inpainting: boolean;
        inpainting_native_unet?: boolean;
        inpainting_kind?: string;
        reference_image: boolean;
        control_net: boolean;
    };
    notes: string[];
}

export type PromptRefineInstruction =
    | "shorten"
    | "enrich"
    | "keep_character"
    | "keep_composition"
    | "keep_style"
    | "regenerate";

export function buildPrompt(
    baseUrl: string,
    input: string,
    mode: PromptMode,
    modelFamily?: string
): Promise<PromptBuildResponse> {
    const body: Record<string, unknown> = { input, mode };
    if (modelFamily) {
        body.model_family = modelFamily;
    }
    return fetchJsonWithBase<PromptBuildResponse>(withBase(baseUrl, "/sdcpp/v1/prompt/build"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export function refinePrompt(
    baseUrl: string,
    spec: PromptSpec,
    instruction: PromptRefineInstruction,
    modelFamily?: string
): Promise<PromptRefineResponse> {
    const body: Record<string, unknown> = { spec, instruction };
    if (modelFamily) {
        body.model_family = modelFamily;
    }
    return fetchJsonWithBase<PromptRefineResponse>(withBase(baseUrl, "/sdcpp/v1/prompt/refine"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export function getPromptLlmStatus(baseUrl: string): Promise<PromptLlmStatus> {
    return fetchJsonWithBase<PromptLlmStatus>(withBase(baseUrl, "/sdcpp/v1/prompt/llm/status"));
}

export interface PromptLlmReleaseResponse {
    released: boolean;
    loaded: boolean;
    reason: string;
}

export function releasePromptLlm(baseUrl: string): Promise<PromptLlmReleaseResponse> {
    return fetchJsonWithBase<PromptLlmReleaseResponse>(withBase(baseUrl, "/sdcpp/v1/prompt/llm/release"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
}

export function getModelCapabilities(baseUrl: string): Promise<ModelCapabilitiesResponse> {
    return fetchJsonWithBase<ModelCapabilitiesResponse>(withBase(baseUrl, "/sdcpp/v1/model/capabilities"));
}
