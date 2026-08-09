export const formsClientScript = `
  (() => {
    const ui = window.GlobalRegistryUi;
    if (!ui || typeof ui.request !== 'function') return;

    const messageForError = (error) => {
      if (error.code === 'revision_conflict') {
        return '他の管理者が先に変更しました。上書きせず、ページを再読み込みして最新の内容を確認してください。';
      }
      if (error.code === 'last_active_admin') {
        return '最後の有効な管理者は、権限変更または無効化できません。先に別の有効な管理者を登録してください。';
      }
      if (error.code === 'self_lockout') {
        return '自分自身の管理者権限を失う変更は、別の有効な管理者が存在する場合だけ実行できます。';
      }
      if (error.code === 'duplicate_actor_identity') {
        return 'このIdentityは既に登録されています。既存のActorを確認してください。';
      }
      if (
        error.code === 'invalid_request' ||
        error.code === 'invalid_actor_create' ||
        error.code === 'invalid_actor_update' ||
        error.code === 'empty_actor_patch'
      ) {
        return '入力内容を確認してください。Identityは access: または service: のcanonical形式で入力します。';
      }
      if (error.code === 'forbidden') {
        return 'この操作を実行する権限がありません。';
      }
      if (error.code === 'not_found') {
        return '対象が見つかりませんでした。ページを再読み込みしてください。';
      }
      return '変更を保存できませんでした。再読み込みしても解消しない場合は管理者へ連絡してください。';
    };

    const formPayload = (form) => {
      const payload = {};
      for (const element of form.elements) {
        if (!element.name || element.disabled || element.type === 'submit') continue;
        if (element.type === 'checkbox') {
          payload[element.name] = element.checked;
          continue;
        }
        if (element.dataset.jsonType === 'number') {
          payload[element.name] = Number(element.value);
          continue;
        }
        payload[element.name] = element.value;
      }
      return payload;
    };

    for (const form of document.querySelectorAll('[data-api-form]')) {
      form.addEventListener('submit', async (event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const status = form.querySelector('[role="status"]');
        const button = form.querySelector('button[type="submit"]');
        if (!status || !button) return;
        status.classList.remove('is-error', 'is-success');
        status.textContent = '保存しています…';
        button.disabled = true;
        try {
          const payload = await ui.request(form.action, {
            method: form.dataset.apiMethod || 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(formPayload(form))
          });
          status.classList.add('is-success');
          status.textContent = '保存しました。';
          const destination = form.dataset.successPath;
          if (destination) {
            const resolved = payload && payload.id
              ? destination.replace('{id}', encodeURIComponent(payload.id))
              : destination;
            window.location.assign(resolved);
          }
        } catch (error) {
          status.classList.add('is-error');
          status.textContent = messageForError(error);
          button.disabled = false;
        }
      });
    }

    for (const form of document.querySelectorAll('[data-operation-form]')) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = form.querySelector('[role="status"]');
        const button = form.querySelector('button[type="submit"]');
        const targetSelect = form.querySelector('[name="targetState"]');
        if (!status || !button || !targetSelect) return;
        status.classList.remove('is-error', 'is-success');
        status.textContent = '操作を作成しています…';
        button.disabled = true;
        try {
          const resourceKey = form.dataset.resourceKey;
          const sourceState = form.dataset.sourceState;
          const revision = Number(form.dataset.resourceRevision);
          const targetState = targetSelect.value;
          await ui.request('/api/v1/operations', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: 'lifecycle_transition',
              intent: { resourceKey, targetState },
              resources: [{
                resourceKey,
                sourceState,
                targetState,
                resourceRevision: revision
              }],
              steps: [{
                position: 0,
                name: 'ライフサイクル遷移を記録',
                gate: { lockRequired: true }
              }]
            })
          });
          status.classList.add('is-success');
          status.textContent = '操作を作成しました。';
          window.location.assign('/ui/operations');
        } catch (error) {
          status.classList.add('is-error');
          status.textContent = messageForError(error);
          button.disabled = false;
        }
      });
    }
  })();
`;
