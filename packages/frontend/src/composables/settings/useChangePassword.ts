import { computed, ref } from 'vue';
import { useAuthStore } from '../../stores/auth.store';
import { useI18n } from 'vue-i18n';

export function useChangePassword() {
  const authStore = useAuthStore();
  const { t } = useI18n();

  const currentPassword = ref('');
  const newPassword = ref('');
  const confirmPassword = ref('');
  const changePasswordLoading = ref(false);
  const changePasswordMessage = ref('');
  const changePasswordSuccess = ref(false);

  /** 桌面端默认账号一开始没有密码，此时这里是「设置密码」而不是「修改密码」 */
  const hasPassword = computed(() => authStore.user?.hasPassword !== false);

  const handleChangePassword = async () => {
    changePasswordMessage.value = '';
    changePasswordSuccess.value = false;

    const isFirstSet = !hasPassword.value;

    if (newPassword.value !== confirmPassword.value) {
      changePasswordMessage.value = t('settings.changePassword.error.passwordsDoNotMatch');
      return;
    }

    if (!newPassword.value) {
      changePasswordMessage.value = t('settings.changePassword.error.newPasswordRequired');
      return;
    }

    // 首次设置时没有当前密码可填，不能要求它
    if (hasPassword.value && !currentPassword.value) {
      changePasswordMessage.value = t('settings.changePassword.error.fieldsRequired');
      return;
    }

    changePasswordLoading.value = true;
    try {
      await authStore.changePassword(currentPassword.value, newPassword.value);
      changePasswordMessage.value = isFirstSet
        ? t('settings.changePassword.successSet')
        : t('settings.changePassword.success');
      changePasswordSuccess.value = true;
      // 从现在起这一块是「修改密码」了，不必等刷新
      if (authStore.user) authStore.user.hasPassword = true;
      currentPassword.value = '';
      newPassword.value = '';
      confirmPassword.value = '';
    } catch (error: any) {
      console.error('修改密码失败:', error);
      changePasswordMessage.value = error.message || t('settings.changePassword.error.generic');
      changePasswordSuccess.value = false;
    } finally {
      changePasswordLoading.value = false;
    }
  };

  return {
    currentPassword,
    newPassword,
    confirmPassword,
    hasPassword,
    changePasswordLoading,
    changePasswordMessage,
    changePasswordSuccess,
    handleChangePassword,
  };
}
