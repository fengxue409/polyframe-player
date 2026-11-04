<script setup lang="ts">
/**
 * P35 清理确认弹窗。
 *
 * 清理是不可撤销的破坏性操作，确认框必须回答三个问题：
 * 删多少（条数）、腾出多少（体积）、删的是哪些（名单预览）。
 * 只写一句「确定清理吗？」的 confirm 让人没法判断影响面。
 */
import { onBeforeUnmount, onMounted } from 'vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    subtitle?: string
    /** 统计块：值 + 标签，例如「12 个 / 任务」「1.2 GB / 可释放」 */
    stats: { label: string; value: string }[]
    /** 清单预览（已截断） */
    names?: string[]
    /** 被截断的剩余条数 */
    rest?: number
    note?: string
    confirmText?: string
    busy?: boolean
    danger?: boolean
  }>(),
  {
    subtitle: '',
    names: () => [],
    rest: 0,
    note: '',
    confirmText: '确认清理',
    busy: false,
    danger: false
  }
)

const emit = defineEmits<{ (e: 'cancel'): void; (e: 'confirm'): void }>()

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') emit('cancel')
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="busy ? undefined : emit('cancel')">
      <div class="modal cd" role="dialog" aria-modal="true" :aria-label="title">
        <h3 class="cd-title">{{ title }}</h3>
        <p v-if="subtitle" class="cd-sub">{{ subtitle }}</p>

        <div class="cd-stats">
          <div v-for="s in stats" :key="s.label" class="cd-stat">
            <span class="cd-stat-v">{{ s.value }}</span>
            <span class="cd-stat-l">{{ s.label }}</span>
          </div>
        </div>

        <ul v-if="names.length" class="cd-names">
          <li v-for="n in names" :key="n" :title="n">{{ n }}</li>
          <li v-if="rest > 0" class="cd-more">…等 {{ rest }} 项</li>
        </ul>

        <p v-if="note" class="cd-note">{{ note }}</p>

        <div class="cd-actions">
          <button class="btn ghost" :disabled="busy" @click="emit('cancel')">取消</button>
          <button
            class="btn"
            :class="danger ? 'danger' : 'primary'"
            :disabled="busy"
            @click="emit('confirm')"
          >
            {{ busy ? '清理中…' : confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cd {
  width: min(460px, 100%);
  padding: var(--sp-5);
}
.cd-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 650;
  color: var(--text);
}
.cd-sub {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  line-height: 1.55;
}
.cd-stats {
  display: flex;
  gap: var(--sp-3);
  margin: var(--sp-4) 0 var(--sp-3);
}
.cd-stat {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.cd-stat-v {
  display: block;
  font-size: var(--fs-sm);
  font-weight: 650;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-stat-l {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.cd-names {
  margin: 0;
  padding: 8px 10px;
  max-height: 148px;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: rgb(0 0 0 / 0.18);
  font-size: var(--fs-2xs);
  color: var(--text-dim);
}
.cd-names li {
  padding: 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-more {
  color: var(--text-faint);
}
.cd-note {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  line-height: 1.5;
}
.cd-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}
</style>
