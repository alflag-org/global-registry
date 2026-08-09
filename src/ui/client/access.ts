export const accessClientScript = `
  (() => {
    for (const button of document.querySelectorAll('[data-copy-target]')) {
      button.addEventListener('click', async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        const status = document.getElementById(button.dataset.copyStatus || '');
        if (!target) return;
        try {
          await navigator.clipboard.writeText(target.textContent || '');
          if (status) status.textContent = 'Identityをコピーしました。';
        } catch {
          const range = document.createRange();
          range.selectNodeContents(target);
          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
          if (status) status.textContent = 'Identityを選択しました。コピー操作を実行してください。';
        }
      });
    }

    for (const form of document.querySelectorAll('[data-access-detail-form]')) {
      form.addEventListener('submit', (event) => {
        const originalRole = form.dataset.originalRole;
        const originalActive = form.dataset.originalActive === 'true';
        const targetActorId = form.dataset.targetActorId;
        const currentActorId = form.dataset.currentActorId;
        const role = form.querySelector('[name="role"]');
        const active = form.querySelector('[name="active"]');
        if (!role || !active) return;
        const removesAdmin = originalRole === 'admin' && role.value !== 'admin';
        const deactivates = originalActive && !active.checked;
        const changesSelfPermission =
          targetActorId === currentActorId && (role.value !== originalRole || active.checked !== originalActive);
        if (!removesAdmin && !deactivates && !changesSelfPermission) return;
        const reasons = [];
        if (removesAdmin) reasons.push('管理者権限を解除します');
        if (deactivates) reasons.push('Actorを無効化します');
        if (changesSelfPermission) reasons.push('自分自身の権限を変更します');
        const confirmed = window.confirm(
          reasons.join('。') + '。この変更を続けますか？'
        );
        if (!confirmed) event.preventDefault();
      });
    }
  })();
`;
