<script setup lang="ts">
import { ref } from "vue";

withDefaults(defineProps<{
    text: string;
    focusable?: boolean;
}>(), {
    focusable: true,
});

const tipRef = ref<HTMLElement | null>(null);
const visible = ref(false);
const x = ref(0);
const y = ref(0);
const below = ref(false);

function show(): void {
    const el = tipRef.value;
    if (!el) {
        return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 12;
    const maxWidth = Math.min(320, window.innerWidth - 32);
    const half = maxWidth / 2;
    x.value = Math.min(Math.max(rect.left + rect.width / 2, margin + half), window.innerWidth - margin - half);
    below.value = rect.top < 120;
    y.value = below.value ? rect.bottom + 8 : rect.top - 8;
    visible.value = true;
}

function hide(): void {
    visible.value = false;
}

function toggle(): void {
    if (visible.value) {
        hide();
    } else {
        show();
    }
}
</script>

<template>
    <span
        ref="tipRef"
        class="info-tip"
        :tabindex="focusable ? 0 : undefined"
        role="note"
        aria-label="提示"
        @mouseenter="show"
        @mouseleave="hide"
        @focus="show"
        @blur="hide"
        @click.stop.prevent="toggle"
    >
        <span class="info-tip__icon" aria-hidden="true">?</span>
        <Teleport to="body">
            <span
                v-if="visible"
                class="info-tip__bubble"
                :class="{ 'info-tip__bubble--below': below }"
                :style="{ left: `${x}px`, top: `${y}px` }"
            >{{ text }}</span>
        </Teleport>
    </span>
</template>
