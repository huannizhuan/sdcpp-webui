import type { ImageInputConfig } from "./types";

export const IMAGE_INPUTS: readonly ImageInputConfig[] = [
    {
        target: "init_image",
        label: "初始图像",
        description: "拖拽、粘贴或浏览图像作为生成种子。",
        layout: "grid",
    },
    {
        target: "mask_image",
        label: "蒙版图像",
        description: "单通道蒙版图像。",
        layout: "grid",
    },
    {
        target: "control_image",
        label: "控制图像",
        description: "ControlNet 风格引导图像。",
        layout: "full",
    },
];

export const VIDEO_IMAGE_INPUTS: readonly ImageInputConfig[] = [
    {
        target: "init_image",
        label: "起始帧",
        description: "可选的第一帧或序列种子图像。",
        layout: "grid",
    },
    {
        target: "end_image",
        label: "结束帧",
        description: "用于插值或 FLF2V 风格运行的可选结束帧。",
        layout: "grid",
    },
];
