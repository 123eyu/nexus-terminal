<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSshKeysStore, SshKeyBasicInfo, SshKeyInput } from '../stores/sshKeys.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import MobileSshKeyManagementModal from './MobileSshKeyManagementModal.vue';

const { isMobile } = useDeviceDetection();

const emit = defineEmits(['close']);

const { t } = useI18n();
const sshKeysStore = useSshKeysStore();
const uiNotificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();

const keys = computed(() => sshKeysStore.sshKeys || []);
const isLoading = computed(() => sshKeysStore.isLoading);

const searchQuery = ref('');
const isAddEditFormVisible = ref(false);
const keyToEdit = ref<SshKeyBasicInfo | null>(null);

// 过滤后的密钥列表
const filteredKeys = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return keys.value;
  return keys.value.filter((k) => k.name.toLowerCase().includes(query));
});

// 表单数据
const initialFormData: SshKeyInput = {
  name: '',
  private_key: '',
  passphrase: '',
};
const formData = reactive({ ...initialFormData });
const formError = ref<string | null>(null);
const showPassphrase = ref(false);

onMounted(() => {
  sshKeysStore.fetchSshKeys();
});

// 显示添加表单
const showAddForm = () => {
  keyToEdit.value = null;
  Object.assign(formData, initialFormData);
  formError.value = null;
  showPassphrase.value = false;
  isAddEditFormVisible.value = true;
};

// 显示编辑表单
const showEditForm = async (key: SshKeyBasicInfo) => {
  formError.value = null;
  keyToEdit.value = key;
  showPassphrase.value = false;

  const details = await sshKeysStore.fetchDecryptedSshKey(key.id);
  if (details) {
    formData.name = details.name;
    formData.private_key = ''; // 留空表示保持原私钥不变
    formData.passphrase = '';
    isAddEditFormVisible.value = true;
  } else {
    uiNotificationsStore.addNotification({
      message: t('sshKeys.modal.errorFetchDetails', '获取密钥详情失败'),
      type: 'error'
    });
    keyToEdit.value = null;
  }
};

// 一键从剪贴板粘贴私钥
const pasteFromClipboard = async () => {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        formData.private_key = text;
        uiNotificationsStore.showSuccess('已粘贴剪贴板私钥内容');
      } else {
        uiNotificationsStore.showWarning('剪贴板为空');
      }
    }
  } catch {
    uiNotificationsStore.showWarning('无法直接访问剪贴板，请手动粘贴');
  }
};

// 提交表单
const handleSubmit = async () => {
  formError.value = null;
  if (!formData.name || (!keyToEdit.value && !formData.private_key)) {
    formError.value = t('sshKeys.modal.errorRequiredFields', '请填写密钥名称和私钥内容');
    return;
  }

  let success = false;
  const dataToSend: Partial<SshKeyInput> = {
    name: formData.name.trim(),
  };

  if (formData.private_key) {
    dataToSend.private_key = formData.private_key.trim();
  }

  if (formData.passphrase) {
    dataToSend.passphrase = formData.passphrase;
  }

  if (keyToEdit.value) {
    success = await sshKeysStore.updateSshKey(keyToEdit.value.id, dataToSend);
  } else {
    success = await sshKeysStore.addSshKey(dataToSend as SshKeyInput);
  }

  if (success) {
    isAddEditFormVisible.value = false;
    keyToEdit.value = null;
    uiNotificationsStore.showSuccess(keyToEdit.value ? '密钥更新成功' : '密钥添加成功');
  } else {
    formError.value = sshKeysStore.error || '保存失败';
  }
};

// 删除密钥
const handleDelete = async (key: SshKeyBasicInfo) => {
  const confirmed = await showConfirmDialog({
    message: t('sshKeys.modal.confirmDelete', { name: key.name })
  });
  if (confirmed) {
    const success = await sshKeysStore.deleteSshKey(key.id);
    if (success) {
      uiNotificationsStore.showSuccess('密钥已删除');
      if (keyToEdit.value?.id === key.id) {
        isAddEditFormVisible.value = false;
        keyToEdit.value = null;
      }
    }
  }
};

const cancelForm = () => {
  isAddEditFormVisible.value = false;
  keyToEdit.value = null;
  formError.value = null;
};
</script>

<template>
  <MobileSshKeyManagementModal
    v-if="isMobile"
    @close="emit('close')"
  />

  <div
    v-else
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 select-none animate-fadeIn"
    @click.self="emit('close')"
  >
    <div
      class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden animate-scaleIn"
      style="background-color: var(--app-bg-color);"
      @click.stop
    >
      <!-- 顶部 Header 栏 -->
      <header class="flex justify-between items-center px-5 py-4 border-b border-border/50 flex-shrink-0 select-none">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-amber-500 text-sm shadow-xs">
            <i class="fas fa-key"></i>
          </div>
          <div>
            <h3 class="text-sm md:text-base font-bold text-foreground tracking-tight leading-snug">
              {{ isAddEditFormVisible ? (keyToEdit ? t('sshKeys.modal.editTitle', '编辑 SSH 密钥') : t('sshKeys.modal.addTitle', '新建 SSH 密钥')) : t('sshKeys.modal.title', 'SSH 密钥管理') }}
            </h3>
            <p class="text-xs text-text-secondary">
              {{ isAddEditFormVisible ? (keyToEdit ? '修改已有密钥凭据与密码短语' : '配置私钥与密码短语以用于免密连接') : '存储与管理连接主机的 SSH 私钥凭据' }}
            </p>
          </div>
        </div>

        <button
          type="button"
          @click="isAddEditFormVisible ? cancelForm() : emit('close')"
          class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
          title="Esc"
        >
          <i class="fas fa-times text-xs"></i>
        </button>
      </header>

      <!-- 主视图：密钥列表 -->
      <div v-if="!isAddEditFormVisible" class="flex flex-col flex-grow overflow-hidden p-5 space-y-4">
        <!-- 搜索与新建工具栏 -->
        <div class="flex items-center gap-3 flex-shrink-0">
          <div class="relative flex-1">
            <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary text-xs"></i>
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('common.search', '搜索密钥...')"
              class="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl border border-border/70 bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
            />
          </div>

          <button
            type="button"
            @click="showAddForm"
            class="h-8 px-3.5 bg-primary text-white text-xs font-semibold rounded-xl shadow-xs hover:bg-primary-hover active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <i class="fas fa-plus text-xs"></i>
            <span>{{ t('sshKeys.modal.addKey', '添加密钥') }}</span>
          </button>
        </div>

        <!-- 密钥卡片列表容器 -->
        <div class="flex-grow overflow-y-auto space-y-2 pr-1 max-h-[50vh]">
          <div v-if="isLoading" class="text-center py-12 text-text-secondary text-xs">
            <i class="fas fa-spinner fa-spin mr-2 text-primary"></i>
            <span>{{ t('sshKeys.modal.loading', '加载密钥列表中...') }}</span>
          </div>

          <div v-else-if="keys.length === 0" class="text-center py-12 space-y-3">
            <div class="w-12 h-12 rounded-2xl bg-muted/40 text-text-secondary/60 flex items-center justify-center mx-auto text-xl">
              <i class="fas fa-shield-alt"></i>
            </div>
            <p class="text-xs text-text-secondary">{{ t('sshKeys.modal.noKeys', '暂无已保存的 SSH 密钥') }}</p>
            <button
              type="button"
              @click="showAddForm"
              class="px-3 py-1.5 text-xs text-primary bg-primary/10 hover:bg-primary/20 rounded-lg font-medium transition-colors cursor-pointer"
            >
              {{ t('sshKeys.modal.addKey', '添加密钥') }}
            </button>
          </div>

          <div v-else-if="filteredKeys.length === 0" class="text-center py-12 text-text-secondary text-xs">
            {{ t('common.noMatchingResults', '无匹配的密钥') }}
          </div>

          <!-- 密钥条目卡片 -->
          <div
            v-for="key in filteredKeys"
            :key="key.id"
            class="flex items-center justify-between p-3.5 rounded-xl border border-border/60 bg-muted/15 hover:border-primary/40 transition-all shadow-2xs group"
          >
            <div class="flex items-center gap-3 min-w-0 mr-3">
              <div class="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center text-xs shrink-0">
                <i class="fas fa-key"></i>
              </div>
              <div class="truncate">
                <div class="text-xs md:text-sm font-semibold text-foreground truncate">{{ key.name }}</div>
                <div class="text-[11px] text-text-secondary flex items-center gap-2 mt-0.5">
                  <span class="inline-flex items-center gap-1">
                    <i class="fas fa-check-circle text-emerald-500 text-[9px]"></i>
                    已安全加密存储
                  </span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                @click="showEditForm(key)"
                class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
                :title="t('sshKeys.modal.edit', '编辑')"
              >
                <i class="fas fa-pencil-alt text-xs"></i>
              </button>
              <button
                type="button"
                @click="handleDelete(key)"
                class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
                :title="t('sshKeys.modal.delete', '删除')"
              >
                <i class="fas fa-trash-alt text-xs"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- 底部 Footer -->
        <div class="flex justify-end pt-3 border-t border-border/50 flex-shrink-0">
          <button
            type="button"
            @click="emit('close')"
            class="px-4 py-2 text-xs font-medium text-text-secondary hover:text-foreground border border-border/70 rounded-xl hover:bg-muted/50 transition-colors cursor-pointer"
          >
            {{ t('common.close', '关闭') }}
          </button>
        </div>
      </div>

      <!-- 子视图：添加/编辑表单 -->
      <div v-else class="flex flex-col flex-grow overflow-hidden p-5">
        <form @submit.prevent="handleSubmit" class="flex-grow overflow-y-auto space-y-4 pr-1">
          <!-- 密钥名称 -->
          <div>
            <label for="key-name" class="block text-xs font-medium text-text-secondary mb-1.5">
              {{ t('sshKeys.modal.keyName', '密钥名称') }} <span class="text-error">*</span>
            </label>
            <input
              type="text"
              id="key-name"
              v-model="formData.name"
              required
              placeholder="例如：生产服务器主力密钥 / id_ed25519"
              class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
            />
          </div>

          <!-- 私钥内容 -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label for="key-private" class="block text-xs font-medium text-text-secondary">
                {{ t('sshKeys.modal.privateKey', '私钥内容 (PEM / OpenSSH)') }}
                <span v-if="!keyToEdit" class="text-error">*</span>
              </label>
              <button
                type="button"
                @click="pasteFromClipboard"
                class="text-[11px] text-primary hover:text-primary-hover flex items-center gap-1 cursor-pointer"
              >
                <i class="fas fa-paste text-[10px]"></i>
                <span>从剪贴板粘贴</span>
              </button>
            </div>
            <textarea
              id="key-private"
              v-model="formData.private_key"
              rows="6"
              :required="!keyToEdit"
              :placeholder="keyToEdit ? '•••••••• (留空表示保留原私钥内容不变)' : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'"
              class="w-full px-3 py-2 text-xs font-mono border border-border/70 rounded-xl bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs resize-y"
            ></textarea>
            <p v-if="keyToEdit" class="text-[11px] text-text-secondary mt-1">编辑模式下留空将不会覆盖现有私钥内容。</p>
          </div>

          <!-- 密码短语 Passphrase -->
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label for="key-passphrase" class="block text-xs font-medium text-text-secondary">
                {{ t('sshKeys.modal.passphrase', '私钥密码短语 (Passphrase)') }}
                <span class="text-text-secondary/70">({{ t('connections.form.optional', '可选') }})</span>
              </label>
              <button
                type="button"
                @click="showPassphrase = !showPassphrase"
                class="text-[11px] text-text-secondary hover:text-foreground flex items-center gap-1 cursor-pointer"
              >
                <i :class="['fas text-[10px]', showPassphrase ? 'fa-eye-slash' : 'fa-eye']"></i>
                <span>{{ showPassphrase ? '隐藏密码' : '显示密码' }}</span>
              </button>
            </div>
            <input
              :type="showPassphrase ? 'text' : 'password'"
              id="key-passphrase"
              v-model="formData.passphrase"
              autocomplete="new-password"
              placeholder="若私钥设置了加密密码短语请输入..."
              class="w-full px-3 py-2 text-xs md:text-sm font-mono border border-border/70 rounded-xl bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
            />
          </div>

          <!-- 错误提示 -->
          <div v-if="formError" class="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs flex items-center gap-2">
            <i class="fas fa-exclamation-circle text-xs shrink-0"></i>
            <span>{{ formError }}</span>
          </div>
        </form>

        <!-- 表单底部操作按钮 -->
        <div class="flex items-center justify-end gap-2.5 pt-4 mt-2 border-t border-border/50 flex-shrink-0">
          <button
            type="button"
            @click="cancelForm"
            class="px-4 py-2 text-xs font-medium text-text-secondary hover:text-foreground border border-border/70 rounded-xl hover:bg-muted/50 transition-colors cursor-pointer"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            @click="handleSubmit"
            :disabled="isLoading"
            class="px-5 py-2 text-xs font-semibold bg-primary text-white rounded-xl shadow-xs hover:bg-primary-hover active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <i v-if="isLoading" class="fas fa-spinner fa-spin text-xs"></i>
            <span>{{ keyToEdit ? t('common.save', '保存修改') : t('common.add', '添加密钥') }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.97); }
  to { opacity: 1; transform: scale(1); }
}
.animate-fadeIn {
  animation: fadeIn 0.15s ease-out forwards;
}
.animate-scaleIn {
  animation: scaleIn 0.15s ease-out forwards;
}
</style>