<script setup lang="ts">
import { onMounted, ref } from "vue";

import InfoTip from "./InfoTip.vue";
import { deleteHistoryEntry, getHistory, getHistoryThumbnail, type HistoryEntry } from "../lib/history";

const props = defineProps<{
    baseUrl: string;
}>();

const emit = defineEmits<{
    (event: "reuse", payload: { prompt: string; negative: string; seed: number; width: number; height: number }): void;
}>();

const entries = ref<HistoryEntry[]>([]);
const thumbnails = ref<Record<string, string>>({});
const loading = ref(false);
const errorMessage = ref("");
const directory = ref("");
const writable = ref(true);
const total = ref(0);

async function load(): Promise<void> {
    loading.value = true;
    errorMessage.value = "";
    try {
        const response = await getHistory(props.baseUrl, 24, 0);
        entries.value = response.items || [];
        directory.value = response.directory || "";
        writable.value = response.writable !== false;
        total.value = response.total || entries.value.length;
        for (const entry of entries.value) {
            void loadThumbnail(entry);
        }
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
        loading.value = false;
    }
}

async function loadThumbnail(entry: HistoryEntry): Promise<void> {
    if (thumbnails.value[entry.id]) {
        return;
    }
    try {
        const response = await getHistoryThumbnail(props.baseUrl, entry.id);
        thumbnails.value = {
            ...thumbnails.value,
            [entry.id]: `data:image/${response.format};base64,${response.b64_json}`,
        };
    } catch {
        // Thumbnails are best effort; the entry stays usable without a preview.
    }
}

async function copyPrompt(entry: HistoryEntry): Promise<void> {
    try {
        await navigator.clipboard.writeText(entry.prompt || "");
    } catch {
        errorMessage.value = "浏览器拒绝写入剪贴板";
    }
}

function reuse(entry: HistoryEntry): void {
    emit("reuse", {
        prompt: entry.prompt || "",
        negative: entry.negative_prompt || "",
        seed: Number.isFinite(entry.seed) ? entry.seed : -1,
        width: entry.width || 0,
        height: entry.height || 0,
    });
}

async function removeEntry(entry: HistoryEntry): Promise<void> {
    if (!window.confirm("从历史记录中移除该条目？磁盘上的图片文件不会被删除。")) {
        return;
    }
    try {
        await deleteHistoryEntry(props.baseUrl, entry.id);
        entries.value = entries.value.filter((item) => item.id !== entry.id);
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    }
}

function formatTime(value: number): string {
    if (!value) {
        return "-";
    }
    return new Date(value * 1000).toLocaleString();
}

onMounted(() => {
    void load();
});

defineExpose({ load });
</script>

<template>
    <section class="history-panel">
        <div class="panel-header">
            <div>
                <h2 class="panel-title">生成历史<InfoTip text="历史直接来自服务器输出目录中的图片及其内嵌生成参数，不会额外复制一份图片。" /></h2>
            </div>
            <button class="btn-secondary" type="button" :disabled="loading" @click="load">{{ loading ? "刷新中..." : "刷新" }}</button>
        </div>

        <div v-if="!writable" class="hint">输出目录不可写（{{ directory || "未配置 --output-dir" }}），历史记录暂不可用。</div>

        <div v-if="entries.length" class="history-grid">
            <article v-for="entry in entries" :key="entry.id" class="history-card">
                <div class="history-card__thumb">
                    <img v-if="thumbnails[entry.id]" :src="thumbnails[entry.id]" :alt="entry.prompt" />
                    <div v-else class="history-card__placeholder">无预览</div>
                </div>
                <div class="history-card__meta">
                    <div class="history-card__prompt" :title="entry.prompt">{{ entry.prompt || "（无提示词信息）" }}</div>
                    <div class="history-card__row">模型 {{ entry.model_name || "-" }}</div>
                    <div class="history-card__row">种子 {{ entry.seed >= 0 ? entry.seed : "-" }} · {{ entry.width || "-" }}×{{ entry.height || "-" }}</div>
                    <div class="history-card__row">{{ formatTime(entry.created_at) }}</div>
                </div>
                <div class="history-card__actions">
                    <button class="btn-secondary" type="button" title="用相同提示词和参数填回生成表单" @click="reuse(entry)">复用参数</button>
                    <button class="btn-secondary" type="button" title="复制提示词到剪贴板" @click="copyPrompt(entry)">复制</button>
                    <button class="btn-danger" type="button" title="仅从历史列表移除，不删除磁盘文件" @click="removeEntry(entry)">移除</button>
                </div>
            </article>
        </div>
        <div v-else-if="!loading" class="hint">还没有历史记录。生成图片后会出现在这里（共 {{ total }} 条）。</div>

        <div v-if="errorMessage" class="status-message status-message--error">{{ errorMessage }}</div>
    </section>
</template>
