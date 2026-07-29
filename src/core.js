/**
 * Open Wegram Bot - Core Logic
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

// 辅助函数：分批调用 deleteMessages（Telegram 限制单次最多 100 条）
async function batchDeleteUserMessages(botToken, targetChatId, startMsgId) {
    const start = Math.max(1, startMsgId - 100);
    const end = startMsgId + 20; // 覆盖后续可能的几条
    const allIds = [];
    for (let id = start; id <= end; id++) {
        allIds.push(id);
    }

    // 分批次，每 90 条发送一次 API 请求
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

      // 删对方侧消息
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: targetChatId,
        message_id: targetMsgId
      });
      // 删管理群抄送
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id
      });
      await postToTelegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '已单条同步删除！'
      });
      return jsonResponse({ ok: true });
    }

    // 2. 批量盲扫删除
    if (data.startsWith('delall:')) {
      const parts = data.split(':');
      const targetChatId = parseInt(parts[1]);
      const startMsgId = parseInt(parts[2]);

      // 执行分组批量删除
      await batchDeleteUserMessages(botToken, targetChatId, startMsgId);

      // 删管理群抄送
      await postToTelegramApi(botToken, 'deleteMessage', {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id
      });

      await postToTelegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '已触发批量全扫删除！'
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
            allowed_updates: ['message', 'callback_query'],
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
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {});
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

    // 1. 优先捕获按钮点击事件
    if (update.callback_query) {
        return await handleCallbackQuery(botToken, update.callback_query);
    }

    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const chatIdStr = message.chat.id.toString();

    try {
        // 2. 独立处理 /deluser 指令（不需要通过 Reply 消息触发）
        if (chatIdStr === ownerUid && message.text && message.text.startsWith('/deluser')) {
            const parts = message.text.trim().split(/\s+/);
            const targetUid = parseInt(parts[1]);

            if (targetUid) {
                // 以当前消息 ID 作为基准推算进行多轮盲扫（扫描最近 300 条消息范围）
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

            // 删掉输入的 /deluser 指令本身
            await postToTelegramApi(botToken, 'deleteMessage', {
                chat_id: message.chat.id,
                message_id: message.message_id
            });

            return new Response('OK');
        }

        // 3. 管理员在群内回复 (Reply) 消息逻辑
        const reply = message.reply_to_message;
        if (reply && chatIdStr === ownerUid) {
            const rm = reply.reply_markup;
            if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                let senderUid = rm.inline_keyboard[0][0].callback_data;
                if (!senderUid && rm.inline_keyboard[0][0].url) {
                    const match = rm.inline_keyboard[0][0].url.match(/id=(\d+)/);
                    if (match) senderUid = match[1];
                }

                // 指令：/del 回复单条抹除
                if (message.text === '/del') {
                    let targetUserMsgId = null;
                    if (reply.reply_markup && reply.reply_markup.inline_keyboard) {
                        const url = reply.reply_markup.inline_keyboard[0][0].url;
                        if (url) {
                            const msgIdMatch = url.match(/msg_id=(\d+)/);
                            if (msgIdMatch) targetUserMsgId = parseInt(msgIdMatch[1]);
                        }
                    }

                    if (targetUserMsgId && senderUid) {
                        await postToTelegramApi(botToken, 'deleteMessage', {
                            chat_id: parseInt(senderUid),
                            message_id: targetUserMsgId
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

                // 管理员正常回复文本给用户
                if (senderUid) {
                    await postToTelegramApi(botToken, 'copyMessage', {
                        chat_id: parseInt(senderUid),
                        from_chat_id: message.chat.id,
                        message_id: message.message_id
                    });
                }
            }
            return new Response('OK');
        }

        if ("/start" === message.text) {
            return new Response('OK');
        }

        // 4. 用户发消息 -> 转发管理群（带单条/批量删除按钮）
        const sender = message.chat;
        const senderUid = sender.id.toString();
        const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

        const copyMessage = async function (withUrl = false) {
            const ik = [[{
                text: `🔓 From: ${senderName} (${senderUid})`,
                callback_data: senderUid,
            }]];

            if (withUrl) {
                ik[0][0].text = `🔐 From: ${senderName} (${senderUid})`;
                ik[0][0].url = `tg://user?id=${senderUid}`;
                ik.push([
                    {
                        text: '🗑️ 单条删除',
                        callback_data: `del:${message.chat.id}:${message.message_id}`
                    },
                    {
                        text: '💥 批量删除',
                        callback_data: `delall:${message.chat.id}:${message.message_id}`
                    }
                ]);
            }

            return await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: {inline_keyboard: ik}
            });
        };

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
