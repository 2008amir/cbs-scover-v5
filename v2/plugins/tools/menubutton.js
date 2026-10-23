import menuButtons from '../../../lib/menu-buttons.js'

let handler = async (m, { EliteProTech, text }) => {
    const prefix = global.prefix ?? '.'
    const usage = `Usage: ${prefix}menubutton menuname; button1:(phone number):(message here); button2:(link):(link here); button3:(telecome):(number here); button4:(chathere):(text here)`
    const reply = value => EliteProTech.sendMessage(m.chat, { text: value }, { quoted: m, fontPlain: true })
    if (!text?.trim()) return reply(usage)
    try { menuButtons.parseMenu(text) }
    catch (error) { return reply(`${error.message}\n\n${usage}`) }
    try { await menuButtons.sendMenu(EliteProTech, m, text) }
    catch (error) {
        console.error('[Menubutton] Menu delivery failed:', error?.message || error)
        return reply('Could not send or save this button menu. Please try again.')
    }
}
handler.command = ['menubutton']
export default handler