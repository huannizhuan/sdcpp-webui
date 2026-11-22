<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import InfoTip from "./InfoTip.vue";
import {
    buildPrompt,
    getPromptLlmStatus,
    releasePromptLlm,
    refinePrompt,
    type PromptLlmStatus,
    type PromptMode,
    type PromptRefineInstruction,
    type PromptSpec,
} from "../lib/prompt";

const props = defineProps<{
    baseUrl: string;
    modelFamily: string;
    supportsNegativePrompt: boolean;
    negativePromptReason: string;
    llmAvailable: boolean;
    llmReason: string;
    // Changes only the wording of the natural language box; masked editing wants
    // the user to describe the change, not the whole picture.
    taskHint?: string;
}>();

const emit = defineEmits<{
    (event: "apply", payload: { positive: string; negative: string }): void;
}>();

const naturalInput = ref("");
const mode = ref<PromptMode>("fast");
const busy = ref(false);
const errorMessage = ref("");
const notes = ref<string[]>([]);
const fallbackReason = ref("");
const positiveDraft = ref("");
const negativeDraft = ref("");
const lastSpec = ref<PromptSpec | null>(null);
const dirty = ref(false);
const elapsedMs = ref(0);
const usedLlm = ref(false);
const llmStatus = ref<PromptLlmStatus | null>(null);
const releasing = ref(false);

let statusTimer = 0;

// Only poll while smart mode is selected: the fast path never touches the model,
// so polling there would keep waking the server for nothing.
const llmBusy = computed(() => Boolean(llmStatus.value?.busy));
const llmLoaded = computed(() => Boolean(llmStatus.value?.loaded));
const llmStateLabel = computed(() => {
    if (!props.llmAvailable) {
        return "不可用";
    }
    if (releasing.value) {
        return "释放中…";
    }
    if (llmBusy.value) {
        return "加载中…";
    }
    if (llmLoaded.value) {
        return "已就绪";
    }
    return "未加载";
});
const actionsDisabled = computed(() => busy.value || llmBusy.value || releasing.value);

async function refreshLlmStatus(): Promise<void> {
    try {
        llmStatus.value = await getPromptLlmStatus(props.baseUrl);
    } catch {
        llmStatus.value = null;
    }
}

function stopStatusPolling(): void {
    if (statusTimer) {
        window.clearTimeout(statusTimer);
        statusTimer = 0;
    }
}

async function pollLlmStatus(): Promise<void> {
    await refreshLlmStatus();
    if (mode.value === "smart" && !statusTimer) {
        statusTimer = window.setTimeout(() => {
            statusTimer = 0;
            void pollLlmStatus();
        }, 3000);
    }
}

async function releaseModel(): Promise<void> {
    if (releasing.value) {
        return;
    }
    releasing.value = true;
    try {
        await releasePromptLlm(props.baseUrl);
        await refreshLlmStatus();
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
        releasing.value = false;
    }
}

watch(mode, (next) => {
    stopStatusPolling();
    if (next === "smart") {
        void pollLlmStatus();
    }
});

onBeforeUnmount(() => {
    stopStatusPolling();
});

const canBuild = computed(() => naturalInput.value.trim().length > 0 && !busy.value);
const isEditTask = computed(() => props.taskHint === "image_edit");
const naturalPlaceholder = computed(() => isEditTask.value
    ? "例如：把这块区域改成短发，保持脸型和光影不变"
    : "例如：生成一张二次元 Galgame 风格的女角色立绘，银色长发，蓝色眼睛，穿黑色制服，站姿，全身构图，背景为夜晚的校园");
const naturalTip = computed(() => isEditTask.value
    ? "只描述要改动的部分：换什么、变成什么样。未圈选的区域会保持原图，不要在这里重写整张画面。"
    : "用中文描述角色、外观、服装、姿势、构图、背景与画风；越具体，助手整理出的提示词越准确。");
const showNegative = computed(() => props.supportsNegativePrompt);
const hasDraft = computed(() => positiveDraft.value.trim().length > 0);

function markDirty(): void {
    dirty.value = true;
}

function applyDraft(): void {
    if (!hasDraft.value) {
        return;
    }
    emit("apply", { positive: positiveDraft.value, negative: showNegative.value ? negativeDraft.value : "" });
}

async function runBuild(): Promise<void> {
    if (!canBuild.value) {
        return;
    }
    if (dirty.value && hasDraft.value) {
        const overwrite = window.confirm("提示词已被手动修改，重新生成会覆盖当前内容。继续吗？");
        if (!overwrite) {
            return;
        }
    }
    busy.value = true;
    errorMessage.value = "";
    try {
        const response = await buildPrompt(props.baseUrl, naturalInput.value.trim(), mode.value, props.modelFamily || undefined);
        positiveDraft.value = response.positive_prompt;
        negativeDraft.value = response.negative_prompt;
        lastSpec.value = response.spec;
        notes.value = response.notes || [];
        fallbackReason.value = response.fallback_reason || "";
        elapsedMs.value = response.elapsed_ms;
        usedLlm.value = response.llm_used;
        dirty.value = false;
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
}

async function runRefine(instruction: PromptRefineInstruction): Promise<void> {
    if (busy.value) {
        return;
    }
    const spec: PromptSpec =
        lastSpec.value ??
        ({
            task: "text_to_image",
            subject: "",
            appearance: [],
            pose: "",
            composition: "",
            background: "",
            style: "",
            positive_prompt: positiveDraft.value,
            negative_prompt: negativeDraft.value,
            notes: [],
            source_input: naturalInput.value,
        } as PromptSpec);
    if (!spec.positive_prompt && !positiveDraft.value) {
        return;
    }
    const payload: PromptSpec = { ...spec, positive_prompt: positiveDraft.value, negative_prompt: negativeDraft.value };

    busy.value = true;
    errorMessage.value = "";
    try {
        const response = await refinePrompt(props.baseUrl, payload, instruction, props.modelFamily || undefined);
        if (response.changed && dirty.value) {
            const overwrite = window.confirm("提示词已被手动修改，应用优化会覆盖当前内容。继续吗？");
            if (!overwrite) {
                return;
            }
        }
        positiveDraft.value = response.positive_prompt;
        negativeDraft.value = response.negative_prompt;
        lastSpec.value = response.spec;
        notes.value = response.notes || [];
        dirty.value = false;
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
}

function regenerate(): void {
    void runBuild();
}
</script>

<template>
    <section class="prompt-assistant">
        <div class="prompt-assistant__header">
            <div>
                <h3 class="prompt-assistant__title">提示词助手<InfoTip text="用自然语言描述画面，助手会按当前模型的习惯整理成提示词。生成结果只是建议，您可以随时手动修改。" /></h3>
            </div>
            <div class="prompt-assistant__modes">
                <button class="mode-chip" :class="{ 'mode-chip--active': mode === 'fast' }" type="button" title="仅使用本地规则，不加载语言模型，速度快、占用低" @click="mode = 'fast'">快速模式</button>
                <button class="mode-chip" :class="{ 'mode-chip--active': mode === 'smart' }" type="button" :title="llmAvailable ? '使用 Qwen3-VL 理解自然语言后再整理提示词' : llmReason || '语言模型不可用，将自动回退到快速模式'" @click="mode = 'smart'">智能模式</button>
            </div>
        </div>

        <div class="field--full">
            <label>自然语言描述<InfoTip :text="naturalTip" /></label>
            <textarea
                v-model="naturalInput"
                :placeholder="naturalPlaceholder"
            />
        </div>

        <div class="prompt-assistant__actions">
            <button class="btn" type="button" :disabled="!canBuild || actionsDisabled" @click="runBuild">
                {{ busy ? "处理中..." : llmBusy ? "模型加载中..." : "生成提示词" }}
            </button>
            <button class="btn-secondary" type="button" :disabled="actionsDisabled || !hasDraft" @click="regenerate" title="按当前描述重新生成一版提示词">重新生成</button>
            <template v-if="mode === 'smart' && llmAvailable">
                <span class="hint" title="语言模型只在需要时加载，空闲后会自动释放">{{ llmStateLabel }}</span>
                <button class="btn-ghost" type="button" :disabled="releasing || llmBusy || !llmLoaded" title="立即卸载语言模型并释放内存" @click="releaseModel">释放模型</button>
            </template>
        </div>

        <div v-if="hasDraft" class="prompt-assistant__draft stack-top">
            <div class="field--full">
                <label>正向提示词<InfoTip text="实际发送给模型的提示词。可直接编辑；编辑后再次优化会先询问是否覆盖。" /></label>
                <textarea v-model="positiveDraft" @input="markDirty" />
            </div>
            <div v-if="showNegative" class="field--full stack-top">
                <label>反向提示词<InfoTip text="不希望出现的内容。当前模型在不支持反向提示词时会隐藏此输入框。" /></label>
                <textarea v-model="negativeDraft" @input="markDirty" />
            </div>
            <div v-else class="hint stack-top">{{ negativePromptReason }}</div>

            <div class="prompt-assistant__refine">
                <button class="btn-secondary" type="button" :disabled="actionsDisabled" @click="runRefine('shorten')">缩短</button>
                <button class="btn-secondary" type="button" :disabled="actionsDisabled" @click="runRefine('enrich')">优化扩充</button>
                <button class="btn-secondary" type="button" :disabled="actionsDisabled" @click="runRefine('keep_character')">保留角色</button>
                <button class="btn-secondary" type="button" :disabled="actionsDisabled" @click="runRefine('keep_composition')">保留构图</button>
                <button class="btn-secondary" type="button" :disabled="actionsDisabled" @click="runRefine('keep_style')">保留画风</button>
            </div>

            <div class="prompt-assistant__actions stack-top">
                <button class="btn" type="button" :disabled="!hasDraft" title="把提示词填入生成表单，不会自动开始生成" @click="applyDraft">应用到生成</button>
                <span v-if="dirty" class="hint">已手动修改</span>
            </div>
        </div>

        <div v-if="notes.length" class="hint stack-top">
            <div v-for="(note, index) in notes" :key="index">· {{ note }}</div>
        </div>
        <div v-if="fallbackReason" class="hint stack-top">已回退到快速模式：{{ fallbackReason }}</div>
        <div v-if="hasDraft" class="hint stack-top">
            用时 {{ elapsedMs }} ms · {{ usedLlm ? "Qwen3-VL 智能模式" : "本地快速模式" }}
        </div>
        <div v-if="errorMessage" class="status-message status-message--error stack-top">{{ errorMessage }}</div>
    </section>
</template>
