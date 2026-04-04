#Requires AutoHotkey v2.0
#SingleInstance Force

contact := A_Args.Length >= 1 ? Trim(A_Args[1]) : ""

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

SearchContact(contactName) {
    Send("^f")
    Sleep(400)
    Send("^a")
    Sleep(100)
    Send("{Backspace}")
    Sleep(150)
    SendText(contactName)
    Sleep(900)
    Send("{Enter}")
    Sleep(900)
}

if (contact = "") {
    FileAppend('{"type":"whatsapp_latest_result","ok":false,"text":"Falta el contacto."}', "*")
    ExitApp
}

ok := ActivateWhatsApp()

if (!ok) {
    FileAppend('{"type":"whatsapp_latest_result","ok":false,"text":"No pude abrir WhatsApp Desktop."}', "*")
    ExitApp
}

Sleep(1200)
SearchContact(contact)

; Primera versión segura:
; abre el chat, pero no intenta extraer texto de forma frágil.
text := "Ya abrí el chat de " contact ", pero leer el último mensaje automáticamente requiere una versión más avanzada."
json := '{"type":"whatsapp_latest_result","ok":true,"text":"' EscapeJson(text) '"}'

FileAppend(json, "*")
ExitApp