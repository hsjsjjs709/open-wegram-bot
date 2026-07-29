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

// --- 监听并处理按钮点击事件 ---
export async function handleCallbackQuery(botToken, callbackQuery) {
  const data = callbackQuery.data;

  // 1. 单条双向删除
  if (data && data.startsWith('del:')) {
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
  if (data && data.startsWith('delall:')) {
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
            allowed_updates: ['message', 'callback_query'], // 核心修复：允许接收按钮点击事件
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

    // 核心修复：点击按钮时，调用 handleCallbackQuery
    if (update.callback_query) {
        return await handleCallbackQuery(botToken, update.callback_query);
    }

    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const reply = message.reply_to_message;

    try {
        // 管理员在管理群内回复消息逻辑
        if (reply && message.chat.id.toString() === ownerUid) {
            const rm = reply.reply_markup;
            if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                let senderUid = rm.inline_keyboard[0][0].callback_data;
                if (!senderUid && rm.inline_keyboard[0][0].url) {
                    const match = rm.inline_keyboard[0][0].url.match(/id=(\d+)/);
                    if (match) senderUid = match[1];
                }

                // 指令：/del 真正双向清除
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
                    } else if (senderUid) {
                        await postToTelegramApi(botToken, 'deleteMessage', {
                            chat_id: parseInt(senderUid),
                            message_id: reply.message_id
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

                // 管理员回复用户私聊（发给用户，不带任何按钮）
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

        // 管理员盲猜批量删除指令：/deluser <ID>
        if (message.text && message.text.startsWith('/deluser')) {
            const args = message.text.split(' ');
            const targetUid = parseInt(args[1]);

            if (targetUid) {
                const estimatedIds = [];
                const baseId = message.message_id;

                for (let i = 0; i < 200; i++) {
                    if (baseId - i > 0) estimatedIds.push(baseId - i);
                    estimatedIds.push(baseId + i);
                }

                await postToTelegramApi(botToken, 'deleteMessages', {
                    chat_id: targetUid,
                    message_ids: estimatedIds
                });

                await postToTelegramApi(botToken, 'deleteMessage', {
                    chat_id: message.chat.id,
                    message_id: message.message_id
                });

                return new Response('OK');
            }
        }

        if ("/start" === message.text) {
            return new Response('OK');
        }

        // 用户发消息给机器人 -> 抄送给管理群（管理群带删除按钮）
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
