/* Menu listing only.
   V1 owns `video`/`ytmp4` routing in merged mode (bridge.owns() defers to
   V1 handlers), so this handler is never invoked there. Registering the
   names here makes the V2 menu list the command while V1 keeps executing
   it — registering a real handler would double-reply on the shared socket. */
let handler = async () => {}

handler.command = ['video', 'ytmp4']
handler.category = 'Download'

export default handler
