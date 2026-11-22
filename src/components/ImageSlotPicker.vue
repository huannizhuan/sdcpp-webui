<script setup lang="ts">
import InfoTip from "./InfoTip.vue";

export interface ImageSlot {
    id: string;
    label: string;
    description: string;
    supported: boolean;
    reason: string;
}

const props = defineProps<{
    slots: ImageSlot[];
}>();

const emit = defineEmits<{
    (event: "pick", payload: { id: string }): void;
}>();

function pick(slot: ImageSlot): void {
    if (!slot.supported) {
        return;
    }
    emit("pick", { id: slot.id });
}
</script>

<template>
    <section class="image-slots">
        <div class="panel-header">
            <div>
                <h2 class="panel-title">图片槽位<InfoTip text="按用途命名的上传槽位。当前模型不支持的能力会保持禁用，并说明原因，不会伪装成可用。" /></h2>
            </div>
        </div>
        <div class="image-slots__grid">
            <div
                v-for="slot in slots"
                :key="slot.id"
                class="image-slot"
                :class="{ 'image-slot--disabled': !slot.supported }"
            >
                <div class="image-slot__head">
                    <strong>{{ slot.label }}</strong>
                    <span class="image-slot__state">{{ slot.supported ? "可用" : "不可用" }}</span>
                </div>
                <p class="image-slot__desc">{{ slot.description }}</p>
                <p v-if="!slot.supported" class="image-slot__reason">{{ slot.reason }}</p>
                <button class="btn-secondary" type="button" :disabled="!slot.supported" @click="pick(slot)">上传</button>
            </div>
        </div>
    </section>
</template>
