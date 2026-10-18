<script setup lang="ts">
import { computed, ref } from "vue";
import InfoTip from "./InfoTip.vue";
import type { ImageEntry } from "../lib/types";

const props = withDefaults(defineProps<{
    label: string;
    description?: string;
    tip?: string;
    preview?: ImageEntry | null;
    items?: ImageEntry[];
    multiple?: boolean;
}>(), {
    description: "",
    tip: "",
    preview: null,
    items: () => [],
    multiple: false,
});

const emit = defineEmits<{
    (e: "select", files: FileList): void;
    (e: "clear"): void;
    (e: "preview", entry: ImageEntry): void;
}>();
const inputRef = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const hasSelection = computed(() => Boolean(props.preview) || props.items.length > 0);

const summary = computed(() => {
    return props.multiple
        ? (props.items.length ? `已选择 ${props.items.length} 个文件` : "未选择文件")
        : (props.preview?.name || "未选择文件");
});

function emitSelection(files: FileList | undefined | null): void {
    if (!files || !files.length) {
        return;
    }
    emit("select", files);
}

function onPick(event: Event): void {
    const target = event.target as HTMLInputElement;
    emitSelection(target.files);
    target.value = "";
}

function onDrop(event: DragEvent): void {
    dragging.value = false;
    emitSelection(event.dataTransfer?.files);
}
</script>

<template>
    <div class="upload-card" :class="{ 'upload-card--active': dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
        <button
            v-if="preview"
            class="upload-card__preview-button"
            type="button"
            title="点击放大查看已选图片"
            @click="$emit('preview', preview)"
        >
            <img
                class="upload-card__preview"
                :src="preview.dataUrl"
                :alt="preview.name"
            />
        </button>
        <div v-else class="upload-card__drop">
            <div class="upload-card__label">{{ label }}<InfoTip v-if="tip" :text="tip" /></div>
            <div>{{ description }}</div>
            <div class="hint">{{ summary }}</div>
        </div>
        <div class="upload-card__actions">
            <button class="btn-ghost" type="button" title="选择一张或多张图片" @click="inputRef?.click()">选择图片</button>
            <button
                v-if="hasSelection"
                class="btn-ghost"
                type="button"
                title="清除已选择的图片"
                @click="$emit('clear')"
            >
                清除
            </button>
            <input
                ref="inputRef"
                type="file"
                accept="image/*"
                :multiple="multiple"
                @change="onPick"
            />
        </div>
    </div>
</template>
