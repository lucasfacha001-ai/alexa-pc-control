#Requires AutoHotkey v2.0
#SingleInstance Force

EscapeJson(str) {
    str := StrReplace(str, "\", "\\")
    str := StrReplace(str, '"', '\"')
    str := StrReplace(str, "`r", "\r")
    str := StrReplace(str, "`n", "\n")
    return str
}

ActivateWhatsApp() {
    if WinExist("ahk_exe WhatsApp.exe") {
        WinActivate("ahk_exe WhatsApp.exe")
        WinWaitActive("ahk_exe WhatsApp.exe",, 5)
        return true
    }

    Run("whatsapp:")
    if WinWait("ahk_exe WhatsApp.exe",, 10) {
        WinActivate("ahk_exe WhatsApp.exe")
        WinWaitActive("ahk_exe WhatsApp.exe",, 5)
        return true
    }

    return false
}

ok := ActivateWhatsApp()

if (!ok) {
    FileAppend('{"type":"whatsapp_unread_result","ok":false,"summary":"No pude abrir WhatsApp Desktop."}', "*")
    ExitApp
}

Sleep(1000)

; Primera versión segura:
; deja el sistema listo para evolucionar sin romper nada.
summary := "WhatsApp está abierto, pero la lectura automática de mensajes nuevos necesita una versión más avanzada de automatización."
json := '{"type":"whatsapp_unread_result","ok":true,"summary":"' EscapeJson(summary) '"}'

FileAppend(json, "*")
ExitApp