import type { ImageInputConfig } from "./types";

export const IMAGE_INPUTS: readonly ImageInputConfig[] = [
    {
        target: "init_image",
        label: "初始图像",
        description: "拖拽、粘贴或浏览图像作为生成种子。",
        tip: "图生图的输入图像，也可通过 Ctrl+V 直接粘贴。图像会被缩放到指定的宽度和高度。",
        layout: "grid",
    },
    {
        target: "control_image",
        label: "控制图像",
        description: "ControlNet 风格引导图像。",
        tip: "ControlNet 等控制模型的引导图，配合“控制强度”使用；线条、深度或姿态图都可以。",
        layout: "full",
    },
];

export const VIDEO_IMAGE_INPUTS: readonly ImageInputConfig[] = [
    {
        target: "init_image",
        label: "起始帧",
        description: "可选的第一帧或序列种子图像。",
        tip: "图生视频的首帧；留空则从文本提示词直接生成视频。",
        layout: "grid",
    },
    {
        target: "end_image",
        label: "结束帧",
        description: "用于插值或 FLF2V 风格运行的可选结束帧。",
        tip: "首尾帧插值（FLF2V）的最后一帧；需要与起始帧配合使用。",
        layout: "grid",
    },
];
