/**
 * Open Wegram Bot - Private Chat Message ID Tracking Edition
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

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
}

// --- 处理按钮点击事件 ---
export async function handleCallbackQuery(botToken, callbackQuery) {
  const data = callbackQuery.data;

  if (data) {
    // 1. 单条精准删除
    if (data.startsWith('del:')) {
      const [, userChatId, userMsgId] = data.split(':');

      // 精准删除用户自己窗口里的那条消息
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: parseInt(userChatId),
        message_id: parseInt(userMsgId)
      });
      // 删掉你私聊窗口里的抄送卡片
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id
      });
      await postToTelegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '已同步抹除对方侧消息！'
      });
      return jsonResponse({ ok: true });
    }

    // 2. 以此消息为基准精准向下盲扫删除用户侧（以 userMsgId 为核心）
    if (data.startsWith('delall:')) {
      const [, userChatId, userMsgIdStr] = data.split(':');
      const userMsgId = parseInt(userMsgIdStr);

      // 围绕对方真正的 Message ID 范围推断 100 条
      const targetIds = [];
      for (let i = -80; i <= 20; i++) {
        if (userMsgId + i > 0) targetIds.push(userMsgId + i);
      }

      await postToTelegramApi(botToken, 'deleteMessages', {
        chat_id: parseInt(userChatId),
        message_ids: targetIds
      });

      // 删掉你私聊窗口里的抄送卡片
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id
      });

      await postToTelegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '已精准扫除对方侧消息！'
      });
      return jsonResponse({ ok: true });
    }
  }

  return jsonResponse({ ok: true });
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({ success: false, message: 'Secret token error.' }, 400);
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const response = await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message', 'callback_query'],
            secret_token: secretToken
        });

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully installed.'});
        }
        return jsonResponse({success: false, message: `Failed: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error: ${error.message}`}, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {});
        const result = await response.json();
        return jsonResponse({success: result.ok});
    } catch (error) {
        return jsonResponse({success: false}, 500);
    }
}

export async function handleWebhook(request, ownerUid, botToken, secretToken) {
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', {status: 401});
    }

    const update = await request.json();

    // 1. 处理点击按钮
    if (update.callback_query) {
        return await handleCallbackQuery(botToken, update.callback_query);
    }

    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const senderIdStr = message.from ? message.from.id.toString() : '';
    const isOwner = (senderIdStr === ownerUid);

    try {
        // === 2. 管理员（你）在私聊里回复消息 ===
        if (isOwner) {
            const reply = message.reply_to_message;
            if (reply) {
                const rm = reply.reply_markup;
                if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                    // 解析第一排的 callback_data (存了 用户ChatID)
                    const userChatId = rm.inline_keyboard[0][0].callback_data;

                    // 解析第二排按钮（存了 用户的原始 Message ID）
                    let userMsgId = null;
                    if (rm.inline_keyboard[1] && rm.inline_keyboard[1][0].callback_data) {
                        const parts = rm.inline_keyboard[1][0].callback_data.split(':');
                        userMsgId = parts[2];
                    }

                    // 如果输入 /del，双向精准清掉
                    if (message.text === '/del') {
                        if (userChatId && userMsgId) {
                            await postToTelegramApi(botToken, 'deleteMessage', {
                                chat_id: parseInt(userChatId),
                                message_id: parseInt(userMsgId)
                            });
                        }
                        await postToTelegramApi(botToken, 'deleteMessage', {
                            chat_id: message.chat.id,
                            message_id: reply.message_id
                        });
                        await postToTelegramApi(botToken, 'deleteMessage', {
                            chat_id: message.chat.id,
                            message_id: message.message_id
                        });
                        return new Response('OK');
                    }

                    // 正常回复文本给对方
                    if (userChatId) {
                        await postToTelegramApi(botToken, 'copyMessage', {
                            chat_id: parseInt(userChatId),
                            from_chat_id: message.chat.id,
                            message_id: message.message_id
                        });
                    }
                }
            }
            return new Response('OK');
        }

        // === 3. 普通用户给机器人发消息 ===
        if (!isOwner) {
            if ("/start" === message.text) return new Response('OK');

            const sender = message.chat;
            const senderUid = sender.id.toString();
            const userMsgId = message.message_id; // 关键：获取用户侧真正的 Message ID！
            const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

            // 构造带准确 ID 的按钮：del:用户ChatID:用户MsgID
            const ik = [
                [{
                    text: `🔐 来自: ${senderName} (${senderUid})`,
                    callback_data: senderUid
                }],
                [
                    {
                        text: '🗑️ 单条删除',
                        callback_data: `del:${senderUid}:${userMsgId}`
                    },
                    {
                        text: '💥 批量删除',
                        callback_data: `delall:${senderUid}:${userMsgId}`
                    }
                ]
            ];

            await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: { inline_keyboard: ik }
            });
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
