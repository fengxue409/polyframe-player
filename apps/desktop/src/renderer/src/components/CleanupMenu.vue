<script setup lang="ts">
/**
 * P35 清理规则下拉（任务页 / 媒体库共用）。
 *
 * 每个菜单项都带「会选中多少条 + 能释放多少」，因为清理是不可撤销操作：
 * 用户点之前就该知道影响面，而不是点完在确认框里才发现选多了。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fmtBytes, type CleanupMenuItem } from '../lib/cleanup'

const props = withDefaults(
  defineProps<{
    items: CleanupMenuItem[]
    label?: string
    disabled?: boolean
  }>(),
  { label: '清理', disabled: false }
)

const emit = defineEmits<{ (e: 'select', key: string): void }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const anyAvailable = computed(() => props.items.some((i) => i.count > 0))

function choose(item: CleanupMenuItem): void {
  if (item.count <= 0) return
  open.value = false
  emit('select', item.key)
}

/** 点面板外 / 按 Esc 收起：下拉不该把页面卡住 */
function onDocClick(ev: MouseEvent): void {
  if (!open.value) return
  if (root.value && !root.value.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="cm">
    <button
      class="btn ghost sm cm-trigger"
      :class="{ open }"
      :disabled="disabled || !anyAvailable"
      :title="anyAvailable ? '按规则批量清理' : '没有可清理的内容'"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="open = !open"
    >
      {{ label }}<span class="cm-caret" aria-hidden="true">▾</span>
    </button>
    <div v-if="open" class="cm-panel" role="menu">
      <button
        v-for="it in items"
        :key="it.key"
        class="cm-item"
        :class="{ danger: it.danger }"
        role="menuitem"
        :disabled="it.count <= 0"
        @click="choose(it)"
      >
        <span class="cm-top">
          <span class="cm-label">{{ it.label }}</span>
          <span class="cm-n">{{ it.count }}</span>
          <span v-if="it.count > 0 && it.bytes" class="cm-size">{{ fmtBytes(it.bytes) }}</span>
        </span>
        <span class="cm-hint">{{ it.hint }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.cm {
  position: relative;
}
.cm-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.cm-caret {
  font-size: 9px;
  opacity: 0.6;
  transition: transform var(--t-fast) var(--ease);
}
.cm-trigger.open .cm-caret {
  transform: rotate(180deg);
}
.cm-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  width: 268px;
  padding: 5px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  background: var(--panel-2);
  box-shadow: var(--shadow-3);
  animation: cm-in var(--t-fast) var(--ease);
}
@keyframes cm-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}
.cm-item {
  display: block;
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  box-shadow: none;
  text-align: left;
  color: var(--text);
  font-size: var(--fs-xs);
  line-height: 1.35;
}
.cm-item:hover:not(:disabled) {
  background: var(--panel-3);
}
.cm-item:disabled {
  opacity: 0.38;
}
.cm-item.danger .cm-label {
  color: var(--danger);
}
.cm-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.cm-label {
  font-weight: 600;
  white-space: nowrap;
}
.cm-n {
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
}
.cm-size {
  margin-left: auto;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.cm-hint {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
</style>
