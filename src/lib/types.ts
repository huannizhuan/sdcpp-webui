import type { CACHE_MODES } from "./form-defaults";

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

export interface ImageEntry {
  name: string;
  type: string;
  dataUrl: string;
}

export type ImageTarget =
  | "init_image"
  | "control_image"
  | "end_image"
  | "ref_images"
  | "control_frames";

export type GenerationMode = "image" | "video";

export interface ImageInputConfig {
  target: ImageTarget;
  label: string;
  description: string;
  tip?: string;
  layout: "grid" | "full";
}

// ---------------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------------

export interface GuidanceParams {
  txt_cfg: number;
  img_cfg: string | number;
  distilled_guidance: number;
  slg_layers: string;
  layer_start: number;
  layer_end: number;
  scale: number;
}

export interface SampleParams {
  scheduler: string;
  sample_method: string;
  sample_steps: number;
  eta: string | number;
  shifted_timestep: number;
  flow_shift: string | number;
  guidance: GuidanceParams;
}

export interface VaeTilingParams {
  enabled: boolean;
  tile_size_w: number;
  tile_size_h: number;
  target_overlap: number;
  rel_size_w: number;
  rel_size_h: number;
}

export interface CacheParams {
  mode: string;
  option: string;
  scm_mask: string;
  scm_policy_dynamic: boolean;
}

export interface FormLoraEntry {
  path: string;
  multiplier: number;
  is_high_noise: boolean;
}

export interface GenerationForm {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  batch_count: number;
  video_frames: number;
  fps: number;
  seed: number;
  clip_skip: number;
  strength: number;
  control_strength: number;
  moe_boundary: number;
  vace_strength: number;
  output_format: string;
  output_compression: number;
  preview_mode: string;
  preview_interval: number;
  sample_params: SampleParams;
  high_noise_sample_params: SampleParams;
  init_image: ImageEntry | null;
  end_image: ImageEntry | null;
  ref_images: ImageEntry[];
  control_frames: ImageEntry[];
  control_image: ImageEntry | null;
  lora: FormLoraEntry[];
  vae_tiling_params: VaeTilingParams;
  cache: CacheParams;
}

// ---------------------------------------------------------------------------
// LoRA
// ---------------------------------------------------------------------------

export interface AvailableLora {
  name: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Capabilities (API response)
// ---------------------------------------------------------------------------

export interface InpaintingCapability {
  // Legacy flag kept for the API contract; the editor no longer uses masks.
  inpainting?: boolean;
  // True only for checkpoints that ship a dedicated inpaint UNet.
  inpainting_native_unet?: boolean;
  // "masked_denoise" is the model independent latent re-blend, "inpaint_unet"
  // means the model itself is an inpaint checkpoint.
  inpainting_kind?: string;
  // "ref_images" is native instruction-driven editing; "masked_denoise" only
  // limits where the sampler may change pixels; "none" hides the UI.
  edit_mode?: string;
  max_ref_images?: number;
  supports_alpha?: boolean;
  supports_circle_edit?: boolean;
  supports_brush_edit?: boolean;
}

export interface EditDefaults {
  steps: number;
  cfg_scale: number;
  sample_method: string;
  width: number;
  height: number;
  size_multiple: number;
  aspect_ratios: Record<string, [number, number]>;
  turbo_sigmas: number[];
}

export interface Capabilities {
  model?: {
    stem?: string;
    name?: string;
    family?: string;
    version?: string;
  };
  capability_matrix?: InpaintingCapability & Record<string, boolean | undefined>;
  edit_defaults?: EditDefaults;
  prompt_assistant?: {
    enabled?: boolean;
    modes?: string[];
    quick_mode_available?: boolean;
    llm_available?: boolean;
    llm_configured?: boolean;
    llm_reason?: string;
  };
  current_mode?: "img_gen" | "vid_gen";
  supported_modes?: Array<"img_gen" | "vid_gen">;
  output_formats?: string[];
  output_formats_by_mode?: Partial<Record<"img_gen" | "vid_gen", string[]>>;
  samplers?: string[];
  schedulers?: string[];
  loras?: AvailableLora[];
  preview_modes?: string[];
  limits?: {
    max_queue_size?: number;
  };
  features?: {
    cancel_queued?: boolean;
    cancel_generating?: boolean;
    preview?: boolean;
  };
  features_by_mode?: Partial<Record<"img_gen" | "vid_gen", Record<string, any>>>;
  defaults?: Record<string, any>;
  defaults_by_mode?: Partial<Record<"img_gen" | "vid_gen", Record<string, any>>>;
}

// ---------------------------------------------------------------------------
// Job (API response)
// ---------------------------------------------------------------------------

export interface ImageOutput {
  index: number;
  b64_json: string;
}

export type JobKind = "img_gen" | "vid_gen";

export interface JobResult {
  images?: ImageOutput[];
  output_format?: string;
  b64_json?: string;
  mime_type?: string;
  fps?: number;
  frame_count?: number;
}

/**
 * Progress reported by the server while a job runs. `completed`/`total` are in
 * `unit` and may be null before the sampler reports its first step.
 */
export interface JobProgress {
  stage?: string;
  detail?: string;
  pass?: number;
  completed?: number | null;
  total?: number | null;
  unit?: string | null;
  stage_elapsed_ms?: number;
  elapsed_ms?: number;
}

export interface Job {
  id: string;
  kind?: JobKind;
  status: string;
  queue_position?: number;
  created?: number;
  started?: number;
  completed?: number;
  result?: JobResult | null;
  preview?: {
    pass: number;
    step: number;
    total_steps: number;
    b64_json: string;
  } | null;
  progress?: JobProgress | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
  // Non-fatal problems reported by the server, for example a mask sent without
  // a base image.
  warnings?: string[];
  // Set while a running job has been asked to stop but the sampler has not
  // reached a cancellation point yet.
  cancel_requested?: boolean;
}

// ---------------------------------------------------------------------------
// Cache mode literal union
// ---------------------------------------------------------------------------

export type CacheMode = (typeof CACHE_MODES)[number];
