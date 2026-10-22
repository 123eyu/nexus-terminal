<template>
  <div class="settings-section-content">
    <h3 class="text-base font-semibold text-foreground mb-3">
      {{ hasPassword ? $t('settings.changePassword.title') : $t('settings.changePassword.setTitle') }}
    </h3>
    <p v-if="!hasPassword" class="text-sm text-text-secondary mb-3">{{ $t('settings.changePassword.noPasswordHint') }}</p>
    <form @submit.prevent="handleChangePassword" class="space-y-4">
      <!-- 没有密码时没有「当前密码」可填，这一栏直接不出现 -->
      <div v-if="hasPassword">
        <label for="currentPassword" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.changePassword.currentPassword') }}</label>
        <input type="password" id="currentPassword" v-model="currentPassword" required
               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
      </div>
      <div>
        <label for="newPassword" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.changePassword.newPassword') }}</label>
        <input type="password" id="newPassword" v-model="newPassword" required
               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
      </div>
      <div>
        <label for="confirmPassword" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.changePassword.confirmPassword') }}</label>
        <input type="password" id="confirmPassword" v-model="confirmPassword" required
               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
      </div>
      <div class="flex items-center justify-between">
        <button type="submit" :disabled="changePasswordLoading"
                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
          {{ changePasswordLoading ? $t('common.loading') : (hasPassword ? $t('settings.changePassword.submit') : $t('settings.changePassword.submitSet')) }}
        </button>
        <p v-if="changePasswordMessage" :class="['text-sm', changePasswordSuccess ? 'text-success' : 'text-error']">{{ changePasswordMessage }}</p>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { useChangePassword } from '../../composables/settings/useChangePassword';

const {
  currentPassword,
  newPassword,
  confirmPassword,
  hasPassword,
  changePasswordLoading,
  changePasswordMessage,
  changePasswordSuccess,
  handleChangePassword,
} = useChangePassword();
</script>

<style scoped>
/* 根据需要添加特定于此组件的样式，或者依赖全局 Tailwind CSS */
</style>
