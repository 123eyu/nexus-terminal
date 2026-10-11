<template>
  <!-- 移动端专属抽屉视图 -->
  <MobileAddEditQuickCommandForm
    v-if="isMobile"
    :command-to-edit="props.commandToEdit"
    :initial-command="props.initialCommand"
    @close="closeForm"
  />

  <!-- 桌面端：经典 Resizable 左右双栏弹窗 -->
  <div v-else class="fixed inset-0 bg-overlay flex justify-center items-center z-50">
    <div
      ref="modalContentRef"
      class="bg-background text-foreground p-6 rounded-xl border border-border/50 shadow-2xl flex flex-col"
      :style="{
        width: resizableWidth ? `${resizableWidth}px` : undefined,
        height: resizableHeight ? `${resizableHeight}px` : undefined,
      }"
    >
      <h2 class="m-0 mb-6 text-center text-xl font-semibold">
        {{ isEditing ? t('quickCommands.form.titleEdit', '编辑快捷指令') : t('quickCommands.form.titleAdd', '添加快捷指令') }}
      </h2>
      <div class="flex-grow flex space-x-6 min-h-0">
        <!-- 左侧：变量管理 -->
        <div class="w-1/3 border-r border-border/30 pr-6 flex flex-col overflow-y-auto">
          <h3 class="text-md font-medium mb-3 text-text-secondary">{{ t('quickCommands.form.variablesTitle', '变量管理') }}</h3>
          <div class="space-y-3 overflow-y-auto flex-grow pr-1 pb-2">
            <div v-if="localVariables.length === 0" class="text-sm text-text-tertiary p-2 border border-dashed border-border/30 rounded-md">
              {{ t('quickCommands.form.noVariables', '暂无变量。点击下方按钮添加。') }}
            </div>
            <div v-for="variable in localVariables" :key="variable.id" class="p-2.5 border border-border/40 rounded-lg bg-input/30 space-y-2">
              <input
                type="text"
                v-model="variable.name"
                :placeholder="t('quickCommands.form.variableNamePlaceholder', '变量名')"
                class="w-full px-3 py-1.5 border border-border/50 rounded-md bg-input text-foreground text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary"
              />
              <textarea
                v-model="variable.value"
                :placeholder="t('quickCommands.form.variableValuePlaceholder', '变量值')"
                rows="2"
                class="w-full px-3 py-1.5 border border-border/50 rounded-md bg-input text-foreground text-xs resize-y min-h-[40px] shadow-sm focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary"
              ></textarea>
              <button
                type="button"
                @click="deleteVariable(variable.id)"
                class="w-full py-1 px-3 text-xs text-error hover:bg-error/10 border border-error/50 rounded-md transition-colors duration-150"
              >
                {{ t('common.delete', '删除') }}
              </button>
            </div>
          </div>
          <button type="button" @click="addVariable" class="mt-3 w-full py-2 px-4 border border-primary/50 text-primary text-sm rounded-md hover:bg-primary/10 transition-colors duration-150">
            {{ t('quickCommands.form.addVariable', '+ 添加变量') }}
          </button>
        </div>

        <!-- 右侧：现有表单 -->
        <form @submit.prevent="handleSubmit" class="w-2/3 space-y-5 flex flex-col">
          <div class="flex-grow space-y-5 pr-1 flex flex-col">
            <div>
              <label for="qc-name" class="block mb-1.5 text-sm font-medium text-text-secondary">{{ t('quickCommands.form.name', '名称:') }}</label>
              <input
                id="qc-name"
                type="text"
                v-model="formData.name"
                :placeholder="t('quickCommands.form.namePlaceholder', '可选，用于快速识别')"
                class="w-full px-4 py-2 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out"
              />
            </div>
            <div class="flex flex-col flex-grow">
              <label for="qc-command" class="block mb-1.5 text-sm font-medium text-text-secondary">{{ t('quickCommands.form.command', '指令:') }} <span class="text-error">*</span></label>
              <textarea
                id="qc-command"
                v-model="formData.command"
                required
                :placeholder="placeholder"
                class="w-full px-4 py-2 border border-border/50 rounded-lg bg-input text-foreground text-sm min-h-[80px] shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out whitespace-nowrap overflow-x-auto flex-grow"
              ></textarea>
              <small v-if="commandError" class="text-error text-xs mt-1 block">{{ commandError }}</small>
            </div>
            <!-- 所属文件夹选择区 -->
            <div>
              <label class="block mb-1.5 text-sm font-medium text-text-secondary">
                <i class="fas fa-folder text-amber-400 mr-1.5"></i>
                {{ t('folders.title', '所属文件夹') }}
              </label>
              <FolderSelect
                v-model="selectedFolderId"
                :folders="quickCommandTagsStore.folders"
                :allow-create="true"
                @create-folder="handleCreateFolder"
                :placeholder="t('folders.selectPlaceholder', '选择所属文件夹...')"
              />
            </div>

            <!-- 独立背景颜色设置区 -->
            <div class="pt-3 border-t border-border/40">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <i class="fas fa-palette text-text-secondary text-sm"></i>
                  <div>
                    <span class="text-sm font-medium text-foreground">{{ t('quickCommands.form.customBackgroundColor', '独立背景颜色') }}</span>
                    <p class="text-xs text-text-secondary">{{ t('quickCommands.form.customBackgroundColorTip', '设定独立背景颜色（优先级高于所属文件夹）') }}</p>
                  </div>
                </div>
                <!-- 开关 -->
                <button
                  type="button"
                  role="switch"
                  :aria-checked="formData.custom_background_color"
                  @click="toggleCustomColor"
                  class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
                  :class="formData.custom_background_color ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-700'"
                >
                  <span
                    class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out"
                    :class="formData.custom_background_color ? 'translate-x-5' : 'translate-x-0'"
                  />
                </button>
              </div>

              <!-- 展开的调色板区域 -->
              <div v-if="formData.custom_background_color" class="mt-3 space-y-2.5 p-3 bg-input/20 border border-border/60 rounded-xl">
                <div class="flex items-center justify-between">
                  <label class="text-xs font-semibold text-text-secondary">{{ t('common.selectColor', '选择颜色') }}</label>
                  <button
                    type="button"
                    @click="handleRandomColor"
                    class="px-2 py-0.5 text-xs font-medium rounded-md bg-header hover:bg-border/60 text-foreground border border-border/70 flex items-center gap-1.5 transition-all active:scale-95 shadow-xs"
                    :title="t('common.randomColorTip', '随机抽取一个颜色')"
                  >
                    <i class="fas fa-dice text-primary"></i>
                    <span>{{ t('common.randomColor', '随机颜色') }}</span>
                  </button>
                </div>

                <!-- 预设色块 -->
                <div class="flex items-center flex-wrap gap-2">
                  <button
                    v-for="color in PRESET_COLORS"
                    :key="color"
                    type="button"
                    @click="formData.background_color = color"
                    class="w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none relative shadow-xs"
                    :style="{ backgroundColor: color }"
                    :class="formData.background_color?.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105' : ''"
                    :title="color"
                  >
                    <i
                      v-if="formData.background_color?.toLowerCase() === color.toLowerCase()"
                      class="fas fa-check text-[10px] text-white drop-shadow-md"
                    ></i>
                  </button>
                </div>

                <!-- 原生拾色器与 HEX 输入框 -->
                <div class="flex items-center gap-2 pt-1">
                  <input
                    type="color"
                    v-model="formData.background_color"
                    class="w-7 h-7 rounded cursor-pointer border border-border/70 bg-transparent p-0.5"
                  />
                  <input
                    type="text"
                    v-model="formData.background_color"
                    placeholder="#3b82f6"
                    class="flex-1 px-2 py-1 text-xs font-mono border border-border/70 rounded-md bg-input text-foreground uppercase focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  />
                </div>
              </div>
            </div>
          </div>
          <!-- 底部按钮区 -->
          <div class="flex justify-end mt-auto pt-4 border-t border-border/50">
            <button type="button" @click="closeForm" class="py-2 px-5 rounded-lg text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground mr-3">{{ t('common.cancel', '取消') }}</button>
            <button type="button" @click="handleExecute" class="py-2 px-5 rounded-lg text-sm font-semibold transition-colors duration-150 bg-[var(--color-success)] text-white border-none shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-success)] mr-3">
              {{ t('quickCommands.form.execute', '执行') }}
            </button>
            <button type="submit" :disabled="isSubmitting || !!commandError" class="py-2 px-5 rounded-lg text-sm font-semibold transition-colors duration-150 bg-primary text-white border-none shadow-md hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed">
              {{ isSubmitting ? t('common.saving', '保存中...') : (isEditing ? t('common.save', '保存') : t('quickCommands.form.add', '添加')) }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useResizable } from '../composables/useResizable';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useI18n } from 'vue-i18n';
import MobileAddEditQuickCommandForm from './MobileAddEditQuickCommandForm.vue';
import { useQuickCommandsStore, type QuickCommandFE } from '../stores/quickCommands.store';
import { useQuickCommandTagsStore } from '../stores/quickCommandTags.store';
import { useSessionStore } from '../stores/session.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store'; 
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents'; 
import { PRESET_COLORS, generateRandomColor } from '../utils/colorUtils';
import FolderSelect from './FolderSelect.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog'; 

const props = defineProps<{
    commandToEdit?: QuickCommandFE | null; // 接收要编辑的指令对象 (应包含标签ID和变量)
    initialCommand?: string; // 初始命令文本（新增时预填）
}>();

const emit = defineEmits(['close']);

const { isMobile } = useDeviceDetection();
const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog(); 
const quickCommandsStore = useQuickCommandsStore();
const quickCommandTagsStore = useQuickCommandTagsStore(); 
const sessionStore = useSessionStore(); 
const uiNotificationsStore = useUiNotificationsStore(); 
const emitWorkspaceEvent = useWorkspaceEventEmitter(); 
const isSubmitting = ref(false);

const modalContentRef = ref<HTMLElement | null>(null);
const R_MIN_WIDTH = 800; // 可调整大小的最小宽度 (像素)
const R_MIN_HEIGHT = 700; // 可调整大小的最小高度 (像素)
const placeholder = t('quickCommands.form.commandPlaceholder') + 'echo "Hello,\${USERNAME}"';

const { width: resizableWidth, height: resizableHeight } = useResizable(modalContentRef, {
  minWidth: R_MIN_WIDTH,
  minHeight: R_MIN_HEIGHT,
});

const isEditing = computed(() => !!(props.commandToEdit && props.commandToEdit.id > 0));

const formData = reactive({
    name: '',
    command: '',
    tagIds: [] as number[],
    custom_background_color: false,
    background_color: '#3b82f6',
});

const toggleCustomColor = () => {
  formData.custom_background_color = !formData.custom_background_color;
  if (formData.custom_background_color && !formData.background_color) {
    formData.background_color = '#3b82f6';
  }
};

const handleRandomColor = () => {
  formData.background_color = generateRandomColor();
};

const selectedFolderId = computed({
  get: () => {
    return formData.tagIds && formData.tagIds.length > 0 ? formData.tagIds[0] : null;
  },
  set: (val: number | null) => {
    formData.tagIds = val !== null ? [val] : [];
  }
});
const localVariables = ref<{ name: string; value: string; id: string }[]>([]);

const commandError = ref<string | null>(null);

// 监听指令内容变化，进行校验
watch(() => formData.command, (newCommand) => {
  if (!newCommand || newCommand.trim().length === 0) {
    commandError.value = t('quickCommands.form.errorCommandRequired', '指令内容不能为空');
  } else {
    commandError.value = null;
  }
});

// 初始化表单数据
onMounted(() => {
  // 仅在桌面端应用 resizable 尺寸初始化
  if (typeof window !== 'undefined' && !isMobile.value) {
    let initialW = Math.min(window.innerWidth * 0.9, 1152); // 目标 90vw，最大 1152px
    let initialH = window.innerHeight * 0.85; // 目标 85vh

    initialW = Math.max(R_MIN_WIDTH, initialW);
    initialH = Math.max(R_MIN_HEIGHT, initialH);

    resizableWidth.value = initialW;
    resizableHeight.value = initialH;
  }

  if (isEditing.value && props.commandToEdit) {
    formData.name = props.commandToEdit.name ?? '';
    formData.command = props.commandToEdit.command;
    formData.tagIds = props.commandToEdit.tagIds ? [...props.commandToEdit.tagIds] : [];
    if (props.commandToEdit.background_color) {
      formData.custom_background_color = true;
      formData.background_color = props.commandToEdit.background_color;
    } else {
      formData.custom_background_color = false;
      formData.background_color = '#3b82f6';
    }
    if (props.commandToEdit.variables) {
      localVariables.value = Object.entries(props.commandToEdit.variables).map(([name, value]) => ({
        name,
        value,
        id: `var-${Date.now()}-${Math.random().toString(36).substring(7)}`
      }));
    } else {
      localVariables.value = [];
    }
  } else if (props.initialCommand) {
    formData.command = props.initialCommand;
  }
});

const handleCreateFolder = async (folderName: string) => {
    if (!folderName || folderName.trim().length === 0) return;
    const newFolder = await quickCommandTagsStore.createFolder(folderName.trim());
    if (newFolder) {
        formData.tagIds = [newFolder.id];
    }
};

const handleDeleteTag = async (tagId: number) => {
    const tagToDelete = quickCommandTagsStore.tags.find(t => t.id === tagId);
    if (!tagToDelete) return;

    const confirmed = await showConfirmDialog({
        message: t('tags.prompts.confirmDelete', { name: tagToDelete.name })
    });
    if (confirmed) {
        const success = await quickCommandTagsStore.deleteTag(tagId);
        if (success) {
            const index = formData.tagIds.indexOf(tagId);
            if (index > -1) {
                 formData.tagIds.splice(index, 1);
            }
        } else {
             showAlertDialog({ title: t('common.error', '错误'), message: t('tags.errorDelete', { error: quickCommandTagsStore.error || '未知错误' }) });
        }
    }
};

const handleSubmit = async () => {
  if (commandError.value) return;

  isSubmitting.value = true;
  let success = false;

  const finalName = formData.name.trim().length > 0 ? formData.name.trim() : null;

  const variablesToSave: Record<string, string> = localVariables.value.reduce((acc, curr) => {
    if (curr.name.trim()) {
      acc[curr.name.trim()] = curr.value;
    }
    return acc;
  }, {} as Record<string, string>);

  const backgroundColorToSave = formData.custom_background_color && formData.background_color
    ? formData.background_color.trim()
    : null;

  if (isEditing.value && props.commandToEdit) {
    success = await quickCommandsStore.updateQuickCommand(
      props.commandToEdit.id,
      finalName,
      formData.command.trim(),
      formData.tagIds,
      variablesToSave,
      backgroundColorToSave
    );
  } else {
    success = await quickCommandsStore.addQuickCommand(
      finalName,
      formData.command.trim(),
      formData.tagIds,
      variablesToSave,
      backgroundColorToSave
    );
  }

  isSubmitting.value = false;
  if (success) {
    closeForm();
  }
};

const closeForm = () => {
  emit('close');
};

const addVariable = () => {
  localVariables.value.push({
    name: '',
    value: '',
    id: `var-${Date.now()}-${Math.random().toString(36).substring(7)}`
  });
};

const deleteVariable = (variableId: string) => {
  localVariables.value = localVariables.value.filter(v => v.id !== variableId);
};

const handleExecute = () => {
  let processedCommand = formData.command;
  const currentVariables = localVariables.value.reduce((acc, curr) => {
    if (curr.name.trim()) {
      acc[curr.name.trim()] = curr.value;
    }
    return acc;
  }, {} as Record<string, string>);

  for (const varName in currentVariables) {
    const placeholder = new RegExp(`\\$\\{${varName}\\}`, 'g');
    processedCommand = processedCommand.replace(placeholder, currentVariables[varName]);
  }

  const variablePlaceholders = formData.command.match(/\$\{[^\}]+\}/g) || [];
  const undefinedVariables: string[] = [];
  variablePlaceholders.forEach(placeholder => {
    const varName = placeholder.substring(2, placeholder.length - 1);
    if (!currentVariables.hasOwnProperty(varName)) {
      undefinedVariables.push(varName);
    }
  });

  if (undefinedVariables.length > 0) {
    uiNotificationsStore.showWarning(
      t('quickCommands.form.warningUndefinedVariables', { variables: undefinedVariables.join(', ') })
    );
  }

  const activeSessionId = sessionStore.activeSessionId;
  if (!activeSessionId) {
    uiNotificationsStore.showError(t('quickCommands.form.errorNoActiveSession', '没有活动的SSH会话可执行指令。'));
    return;
  }

  emitWorkspaceEvent('quickCommand:executeProcessed', {
    command: processedCommand,
    sessionId: activeSessionId
  });

  closeForm(); 
};
</script>

<style scoped>
.bg-overlay {
  background-color: rgba(0, 0, 0, 0.6);
}
</style>
