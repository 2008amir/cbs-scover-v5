export async function sendRichHtml(EliteProTech, chat, { id, title, html, source }) {
    const responseId = `${id}-${Date.now()}`
    const payload = {
        response_id: responseId,
        sections: [{
            view_model: {
                primitive: {
                    __typename: 'GenAIaeacdsnwHtmlPrimitive',
                    payload: html,
                    trusted_sources: [source]
                },
                __typename: 'GenAISingleLayoutViewModel'
            }
        }]
    }

    await EliteProTech.relayMessage(chat, {
        messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            botMetadata: {
                messageDisclaimerText: '',
                botResponseId: responseId
            }
        },
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: 1,
                    submessages: [{ messageType: 2, messageText: title }],
                    unifiedResponse: {
                        data: Buffer.from(JSON.stringify(payload)).toString('base64')
                    },
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
                        forwardOrigin: 4
                    }
                }
            }
        }
    }, {})

    // Many WhatsApp versions cannot show rich cards; an HTML file opens in any phone's browser.
    const name = String(title || id).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'game'
    await EliteProTech.sendMessage(chat, {
        document: Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body>${html}</body></html>`),
        mimetype: 'text/html',
        fileName: `${name}.html`,
        caption: 'If the card above shows "your version of WhatsApp doesn\'t support it", open this file to play.'
    })
}