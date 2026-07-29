/**
 * Open Wegram Bot - Core Logic (Private Chat Optimized)
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

// 辅助函数：分批调用 deleteMessages
async function batchDeleteUserMessages(botToken, targetChatId, startMsgId) {
    // 盲扫范围：以基准 ID 为中心，前后扫描 300 条
    const start = Math.max(1, startMsgId - 200);
    const end = startMsgId + 100;
    const allIds = [];
    for (let id = start; id <= end; id++) {
        allIds.push(id);
    }

    // 分批发送（每次 90 条）
    for (let i = 0; i < allIds.length; i += 90) {
        const chunk = allIds.slice(i, i + 90);
        await postToTelegramApi(botToken, 'deleteMessages', {
            chat_id: targetChatId,
            message_ids: chunk
        });
    }
}

// --- 处理按钮点击事件 ---
export async function handleCallbackQuery(botToken, callbackQuery) {
  const data = callbackQuery.data;

  if (data) {
    // 1. 单条删除
    if (data.startsWith('del:')) {
      const parts = data.split(':');
      const targetChatId = parseInt(parts[1]);
      const targetMsgId = parseInt(parts[2]);

      // 抹掉对方侧消息
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: targetChatId,
        message_id: targetMsgId
      });
      // 抹掉私聊窗口里发给你的这条中转消息
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id
      });
      await postToTelegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '已同步抹除对方消息！'
      });
      return jsonResponse({ ok: true });
    }

    // 2. 批量盲扫删除
    if (data.startsWith('delall:')) {
      const parts = data.split(':');
      const targetChatId = parseInt(parts[1]);
      const startMsgId = parseInt(parts[2]);

      await batchDeleteUserMessages(botToken, targetChatId, startMsgId);

      // 抹掉私聊窗口里的这条中转消息
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id
      });

      await postToTelegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '已成功批量抹除对方消息！'
      });
      return jsonResponse({ ok: true });
    }
  }

  return jsonResponse({ ok: true });
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

    // 1. 优先处理按钮点击
    if (update.callback_query) {
        return await handleCallbackQuery(botToken, update.callback_query);
    }

    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    // 获取消息发送人的真实 Telegram 数字 ID
    const senderIdStr = message.from ? message.from.id.toString() : '';

    // 判断发送者是否是你本人（管理员）
    const isOwner = (senderIdStr === ownerUid);

    try {
        // === 2. 管理员（你）在私聊里的操作逻辑 ===
        if (isOwner) {

            // A. 指令：/deluser <用户ID>（按 ID 批量强删）
            if (message.text && message.text.startsWith('/deluser')) {
                const parts = message.text.trim().split(/\s+/);
                const targetUid = parseInt(parts[1]);

                if (targetUid) {
                    // 盲扫目标用户侧最近 300 条消息
                    const baseId = message.message_id + 50; 
                    for (let start = Math.max(1, baseId - 300); start <= baseId; start += 90) {
                        const chunk = [];
                        for (let id = start; id < start + 90; id++) {
                            chunk.push(id);
                        }
                        await postToTelegramApi(botToken, 'deleteMessages', {
                            chat_id: targetUid,
                            message_ids: chunk
                        });
                    }
                }

                // 删掉你发出的 /deluser 指令本身
                await postToTelegramApi(botToken, 'deleteMessage', {
                    chat_id: message.chat.id,
                    message_id: message.message_id
                });

                return new Response('OK');
            }

            // B. 管理员回复 (Reply) 某条中转消息
            const reply = message.reply_to_message;
            if (reply) {
                const rm = reply.reply_markup;
                if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                    // 从第一排按钮提取目标用户的 Chat ID
                    let targetUserUid = null;
                    const btn = rm.inline_keyboard[0][0];
                    
                    if (btn.callback_data) {
                        targetUserUid = btn.callback_data;
                    } else if (btn.url) {
                        const match = btn.url.match(/id=(\d+)/);
                        if (match) targetUserUid = match[1];
                    }

                    // 回复 /del 指令：精细删除
                    if (message.text === '/del') {
                        if (targetUserUid) {
                            // 尝试抹除对方私聊框的消息
                            await postToTelegramApi(botToken, 'deleteMessage', {
                                chat_id: parseInt(targetUserUid),
                                message_id: reply.message_id
                            });
                        }
                        // 删掉你私聊框里的中转消息和 /del 指令
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
                    if (targetUserUid) {
                        await postToTelegramApi(botToken, 'copyMessage', {
                            chat_id: parseInt(targetUserUid),
                            from_chat_id: message.chat.id,
                            message_id: message.message_id
                        });
                    }
                }
                return new Response('OK');
            }

            // 如果不是指令也不是回复，普通发言直接忽略
            return new Response('OK');
        }

        // === 3. 普通用户发送给机器人的消息 ===
        if (!isOwner) {
            if ("/start" === message.text) {
                return new Response('OK');
            }

            const sender = message.chat;
            const senderUid = sender.id.toString();
            const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

            // 转发给你的私聊窗口（带有按钮和 ID）
            const ik = [
                [{
                    text: `🔐 来自: ${senderName} (${senderUid})`,
                    callback_data: senderUid
                }],
                [
                    {
                        text: '🗑️ 单条删除',
                        callback_data: `del:${message.chat.id}:${message.message_id}`
                    },
                    {
                        text: '💥 批量删除',
                        callback_data: `delall:${message.chat.id}:${message.message_id}`
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
