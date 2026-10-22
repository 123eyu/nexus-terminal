<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import SshKeySelector from './SshKeySelector.vue';
import SshKeyInlineField from './connection/SshKeyInlineField.vue';

// Define Props. formData is expected to be a reactive object from the parent composable.
const props = defineProps<{
  formData: {
    type: 'SSH' | 'RDP' | 'VNC';
    username: string;
    auth_method: 'password' | 'key'; // SSH specific
    password?: string; // Optional because it might not be set or sent
    selected_ssh_key_id: number | null; // SSH specific
    vncPassword?: string; // VNC specific, optional for the same reasons as password
    // 内联新建密钥（随连接一起提交，见 SshKeyInlineField）
    private_key?: string;
    passphrase?: string;
    ssh_key_name?: string;
    host?: string;
    name?: string;
  };
  isEditMode: boolean; // To determine if fields are required
}>();

const { t } = useI18n();
</script>

<template>
  <!-- 认证凭据卡片：立体卡片 -->
  <div
    class="rounded-2xl border border-border/70 surface-raised p-4 md:p-5 space-y-4 shadow-sm"
  >
    <div class="flex items-center justify-between pb-2.5 border-b border-border/50">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded-md bg-amber-500/15 text-amber-500 flex items-center justify-center text-xs">
          <i class="fas fa-key"></i>
        </div>
        <h4 class="text-xs font-semibold text-foreground tracking-wide uppercase">{{ t('connections.form.sectionAuth', '认证凭据') }}</h4>
      </div>
    </div>

    <!-- 用户名 -->
    <div>
      <label for="conn-username" class="block text-xs font-medium text-text-secondary mb-1.5">
        {{ t('connections.form.username') }}
        <span class="text-text-secondary/60 font-normal">({{ t('connections.form.defaultRoot', '留空默认 root') }})</span>
      </label>
      <input
        type="text"
        id="conn-username"
        v-model="props.formData.username"
        placeholder="root"
        class="w-full px-3 py-2 text-xs md:text-sm font-mono border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
      />
    </div>

    <!-- SSH 认证方式选择 -->
    <template v-if="props.formData.type === 'SSH'">
      <div>
        <label class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.authMethod') }}</label>
        <div
          class="grid grid-cols-2 gap-1.5 p-1 rounded-xl border border-border/70 bg-input"
        >
          <button
            type="button"
            @click="props.formData.auth_method = 'password'"
            class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            :class="props.formData.auth_method === 'password' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
          >
            <i class="fas fa-lock text-[10px]"></i>
            <span>{{ t('connections.form.authMethodPassword') }}</span>
          </button>
          <button
            type="button"
            @click="props.formData.auth_method = 'key'"
            class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            :class="props.formData.auth_method === 'key' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
          >
            <i class="fas fa-certificate text-[10px]"></i>
            <span>{{ t('connections.form.authMethodKey') }}</span>
          </button>
        </div>
      </div>

      <div v-if="props.formData.auth_method === 'password'">
        <label for="conn-password" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.password') }}</label>
        <input
          type="password"
          id="conn-password"
          v-model="props.formData.password"
          :required="props.formData.auth_method === 'password' && !isEditMode"
          autocomplete="new-password"
          :placeholder="isEditMode ? '•••••••• (留空保持不变)' : '输入主机密码...'"
          class="w-full px-3 py-2 text-xs md:text-sm font-mono border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        />
      </div>

      <SshKeyInlineField v-if="props.formData.auth_method === 'key'" :form-data="props.formData">
        <SshKeySelector v-model="props.formData.selected_ssh_key_id" />
      </SshKeyInlineField>
    </template>

    <!-- RDP 认证 -->
    <template v-if="props.formData.type === 'RDP'">
      <div>
        <label for="conn-password-rdp" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.password') }}</label>
        <input
          type="password"
          id="conn-password-rdp"
          v-model="props.formData.password"
          :required="!isEditMode"
          autocomplete="new-password"
          :placeholder="isEditMode ? '•••••••• (留空保持不变)' : '输入远程桌面密码...'"
          class="w-full px-3 py-2 text-xs md:text-sm font-mono border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        />
      </div>
    </template>

    <!-- VNC 认证 -->
    <template v-if="props.formData.type === 'VNC'">
      <div>
        <label for="conn-password-vnc" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.vncPassword', 'VNC 密码') }}</label>
        <input
          type="password"
          id="conn-password-vnc"
          v-model="props.formData.vncPassword"
          :required="!isEditMode"
          autocomplete="new-password"
          :placeholder="isEditMode ? '•••••••• (留空保持不变)' : '输入 VNC 访问密码...'"
          class="w-full px-3 py-2 text-xs md:text-sm font-mono border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        />
      </div>
    </template>
  </div>
</template>