/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */

export function validateSecretToken(token) {
    return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {'Content-Type': 'application/json'}
    });
}
// --- 监听按钮点击事件 ---
export async function handleCallbackQuery(botToken, callbackQuery) {
  const data = callbackQuery.data;

  // 1. 单条双向删除
  if (data.startsWith('del:')) {
    const [, userChatId, userMsgId] = data.split(':');
    await postToTelegramApi(botToken, 'deleteMessage', {
      chat_id: parseInt(userChatId),
      message_id: parseInt(userMsgId)
    });
    await postToTelegramApi(botToken, 'deleteMessage', {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id
    });
    await postToTelegramApi(botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '已双向删除！'
    });
    return jsonResponse({ ok: true });
  }

  // 2. 批量双向删除
  if (data.startsWith('delall:')) {
    const [, userChatId, startMsgId] = data.split(':');
    const startId = parseInt(startMsgId);
    const batchIds = [];
    for (let i = -50; i <= 50; i++) {
      if (startId + i > 0) batchIds.push(startId + i);
    }
    await postToTelegramApi(botToken, 'deleteMessages', {
      chat_id: parseInt(userChatId),
      message_ids: batchIds
    });
    await postToTelegramApi(botToken, 'deleteMessage', {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id
    });
    await postToTelegramApi(botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '已触发批量删除！'
    });
    return jsonResponse({ ok: true });
  }
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const response = await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message'],
            secret_token: secretToken
        });

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully installed.'});
        }

        return jsonResponse({success: false, message: `Failed to install webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error installing webhook: ${error.message}`}, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {})

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully uninstalled.'});
        }

        return jsonResponse({success: false, message: `Failed to uninstall webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error uninstalling webhook: ${error.message}`}, 500);
    }
}

export async function handleWebhook(request, ownerUid, botToken, secretToken) {
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', {status: 401});
    }

    const update = await request.json();
    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const reply = message.reply_to_message;
    try {
        if (reply && message.chat.id.toString() === ownerUid) {
            const rm = reply.reply_markup;
            if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                let senderUid = rm.inline_keyboard[0][0].callback_data;
                if (!senderUid) {
                    senderUid = rm.inline_keyboard[0][0].url.split('tg://user?id=')[1];
                }
    // === 真正的双向清除逻辑 ===
    if (message.text === '/del' && message.reply_to_message) {
      const replyMsg = message.reply_to_message;
      let targetUserMsgId = null;

      // 1. 从按钮链接中提取用户原始消息的 ID
      if (replyMsg.reply_markup && replyMsg.reply_markup.inline_keyboard) {
        const url = replyMsg.reply_markup.inline_keyboard[0][0].url;
        const msgIdMatch = url.match(/msg_id=(\d+)/);
        if (msgIdMatch) {
          targetUserMsgId = parseInt(msgIdMatch[1]);
        }
      }

      // 2. 双向删除：删除用户手机里的那条消息
      if (targetUserMsgId) {
        await postToTelegramApi(botToken, 'deleteMessage', {
          chat_id: parseInt(senderUid),
          message_id: targetUserMsgId
        });
      } else {
        // 如果没找到按钮里的 ID，退而求其次尝试删除对应编号
        await postToTelegramApi(botToken, 'deleteMessage', {
          chat_id: parseInt(senderUid),
          message_id: replyMsg.message_id
        });
      }

      // 3. 双向删除：同时把管理群里的中转消息删掉
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: message.chat.id,
        message_id: replyMsg.message_id
      });

      // 4. 清理管理员发出的 /del 指令本身
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: message.chat.id,
        message_id: message.message_id
      });

      return new Response('OK');
    }
    // ===========================

   

                await postToTelegramApi(botToken, 'copyMessage', {
                    chat_id: parseInt(senderUid),
                    from_chat_id: message.chat.id,
                    message_id: message.message_id
                });
            }

            return new Response('OK');
        }

        if ("/start" === message.text) {
            return new Response('OK');
        }

        const sender = message.chat;
        const senderUid = sender.id.toString();
        const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

        const copyMessage = async function (withUrl = false) {
            const ik = [[{
                text: `🔏 From: ${senderName} (${senderUid})`,
                callback_data: senderUid,
            }]];

            if (withUrl) {
                ik[0][0].text = `🔓 From: ${senderName} (${senderUid})`
                ik[0][0].url = `tg://user?id=${senderUid}`;
            }

            return await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: {inline_keyboard: ik}
            });
        }

        const response = await copyMessage(true);
        if (!response.ok) {
            await copyMessage();
        }

        return new Response('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        return new Response('Internal Server Error', {status: 500});
    }
}

export async function handleRequest(request, config) {
    const {prefix, secretToken} = config;

    const url = new URL(request.url);
    const path = url.pathname;

    const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
    const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
    const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

    let match;

    if (match = path.match(INSTALL_PATTERN)) {
        return handleInstall(request, match[1], match[2], prefix, secretToken);
    }

    if (match = path.match(UNINSTALL_PATTERN)) {
        return handleUninstall(match[1], secretToken);
    }

    if (match = path.match(WEBHOOK_PATTERN)) {
        return handleWebhook(request, match[1], match[2], secretToken);
    }

    return new Response('Not Found', {status: 404});
}