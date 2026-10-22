<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';

/**
 * 「SSH 密钥」字段：默认选已有密钥，点右侧「新建密钥」就地展开一个内联表单。
 *
 * 这个内联表单**没有保存按钮**：私钥内容跟着连接表单一起提交，
 * 连接创建成功后由 useAddConnectionForm 把它存成一把正式密钥（失败会回滚删掉）。
 * 选择器通过默认插槽传进来 —— 桌面端是 SshKeySelector，移动端是 MobileSshKeySelector。
 */
const props = withDefaults(
  defineProps<{
    formData: {
      selected_ssh_key_id?: number | null;
      private_key?: string;
      passphrase?: string;
      /** 内联新建时的密钥名称（可选，留空自动取名） */
      ssh_key_name?: string;
      username?: string;
      host?: string;
      name?: string;
    };
    compact?: boolean;
  }>(),
  { compact: false }
);

const { t } = useI18n();
const uiNotificationsStore = useUiNotificationsStore();

const isInlineOpen = ref(false);
/** 展开前选中的密钥：没填内容就收起时还回去，别让用户白丢一次选择 */
const previousKeyId = ref<number | null>(null);

const hasKeyContent = computed(() => (props.formData.private_key || '').trim().length > 0);

// 用户在内联表单里打过字就保持展开；一旦从下拉里选了已有密钥，就收起内联表单
watch(
  () => props.formData.selected_ssh_key_id,
  (newId) => {
    if (newId !== null && newId !== undefined) isInlineOpen.value = false;
  }
);

const toggleInline = () => {
  if (isInlineOpen.value) {
    isInlineOpen.value = false;
    // 什么都没填就收起 → 把原来的选择还回去
    if (!hasKeyContent.value) props.formData.selected_ssh_key_id = previousKeyId.value;
    return;
  }
  // 内联新建与「选已有」互斥，否则提交时不知道该用哪个
  previousKeyId.value = props.formData.selected_ssh_key_id ?? null;
  props.formData.selected_ssh_key_id = null;
  isInlineOpen.value = true;
};

/** 留空时的兜底名称，省得用户还得先想个名字 */
const autoKeyName = computed(() => {
  const base = (props.formData.name || '').trim() || (props.formData.host || '').trim();
  if (base) return `${base}-key`;
  const user = (props.formData.username || '').trim() || 'root';
  return `${user}-key`;
});

const pasteFromClipboard = async () => {
  try {
    const text = await navigator.clipboard?.readText?.();
    if (text) {
      props.formData.private_key = text;
      uiNotificationsStore.showSuccess(t('connections.form.inlineKeyPasted', '已粘贴剪贴板内容'));
    } else {
      uiNotificationsStore.showWarning(t('connections.form.inlineKeyClipboardEmpty', '剪贴板为空'));
    }
  } catch {
    uiNotificationsStore.showWarning(t('connections.form.inlineKeyClipboardDenied', '无法读取剪贴板，请手动粘贴'));
  }
};

const inputClass = computed(() =>
  props.compact
    ? 'w-full px-3 h-10 text-xs font-mono border border-border/70 rounded-xl bg-input text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors'
    : 'w-full px-3 py-2 text-xs border border-border/70 rounded-xl bg-input text-foreground placeholder:text-text-secondary/60 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs'
);
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <label class="block text-xs font-medium text-text-secondary">
        {{ t('connections.form.sshKey', 'SSH 密钥') }}
        <span v-if="!hasKeyContent && !formData.selected_ssh_key_id" class="text-error">*</span>
      </label>
      <button
        type="button"
        class="text-[11px] font-medium text-primary hover:text-primary-hover flex items-center gap-1 cursor-pointer rounded-md px-1.5 py-0.5 hover:bg-primary/10 transition-colors"
        @click="toggleInline"
      >
        <i :class="['fas text-[10px]', isInlineOpen ? 'fa-chevron-up' : 'fa-plus']"></i>
        <span>{{ isInlineOpen ? t('connections.form.inlineKeyCollapse', '收起') : t('connections.form.inlineKeyToggle', '新建密钥') }}</span>
      </button>
    </div>

    <!-- 选择已有密钥 -->
    <slot v-if="!isInlineOpen" />

    <!-- 内联新建（无保存按钮：随连接一起提交） -->
    <div v-else class="surface-inset rounded-xl border border-border/60 p-3 space-y-2.5">
      <div>
        <label for="inline-key-name" class="block text-[11px] font-medium text-text-secondary mb-1">
          {{ t('connections.form.inlineKeyName', '密钥名称') }}
          <span class="font-normal opacity-70">({{ t('connections.form.optional', '可选') }})</span>
        </label>
        <input
          id="inline-key-name"
          v-model="props.formData.ssh_key_name"
          type="text"
          autocapitalize="off"
          spellcheck="false"
          :placeholder="autoKeyName"
          :class="inputClass"
        />
      </div>

      <div>
        <div class="flex items-center justify-between mb-1">
          <label for="inline-key-private" class="block text-[11px] font-medium text-text-secondary">
            {{ t('connections.form.inlineKeyPrivate', '私钥内容') }}
            <span class="text-error">*</span>
          </label>
          <button
            type="button"
            class="text-[11px] text-primary hover:text-primary-hover flex items-center gap-1 cursor-pointer"
            @click="pasteFromClipboard"
          >
            <i class="fas fa-paste text-[10px]"></i>
            <span>{{ t('connections.form.inlineKeyPaste', '从剪贴板粘贴') }}</span>
          </button>
        </div>
        <textarea
          id="inline-key-private"
          v-model="props.formData.private_key"
          :rows="compact ? 4 : 5"
          spellcheck="false"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          :class="[inputClass, 'py-2 resize-y font-mono leading-relaxed']"
        ></textarea>
      </div>

      <div>
        <label for="inline-key-passphrase" class="block text-[11px] font-medium text-text-secondary mb-1">
          {{ t('connections.form.inlineKeyPassphrase', '密码短语') }}
          <span class="font-normal opacity-70">({{ t('connections.form.optional', '可选') }})</span>
        </label>
        <input
          id="inline-key-passphrase"
          v-model="props.formData.passphrase"
          type="password"
          autocomplete="new-password"
          placeholder="••••••••"
          :class="inputClass"
        />
      </div>

      <p class="flex items-start gap-1.5 text-[11px] leading-relaxed text-text-secondary">
        <i class="fas fa-circle-info text-[10px] mt-0.5 shrink-0"></i>
        <span>{{ t('connections.form.inlineKeyAutoSave', '连接添加成功后会自动保存这把密钥，无需单独保存。') }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
/* style.css 里 `i, .fas, .far, .fab { color: var(--icon-color) }` 是未分层规则，
   会无条件盖过继承色 —— 这里的图标要跟按钮/正文同色，显式 inherit。 */
i {
  color: inherit;
}
</style>
