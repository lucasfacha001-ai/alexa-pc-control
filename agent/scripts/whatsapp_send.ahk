#Requires AutoHotkey v2.0
#SingleInstance Force

contact := A_Args.Length >= 1 ? Trim(A_Args[1]) : ""
message := A_Args.Length >= 2 ? A_Args[2] : ""

if (contact = "" || message = "") {
    MsgBox "Falta el contacto o el mensaje."
    ExitApp
}

ActivateWhatsApp() {
    ; Si WhatsApp ya está abierto, actívalo
    if WinExist("ahk_exe WhatsApp.exe") {
        WinActivate("ahk_exe WhatsApp.exe")
        WinWaitActive("ahk_exe WhatsApp.exe",, 5)
        Sleep 1200
        return true
    }

    ; Intenta abrir WhatsApp Desktop
    Run("whatsapp:")
    Sleep 4000

    ; Vuelve a intentar detectar la ventana
    if WinExist("ahk_exe WhatsApp.exe") {
        WinActivate("ahk_exe WhatsApp.exe")
        WinWaitActive("ahk_exe WhatsApp.exe",, 5)
        Sleep 1200
        return true
    }

    ; Intento alternativo por título de ventana
    if WinExist("WhatsApp") {
        WinActivate("WhatsApp")
        WinWaitActive("WhatsApp",, 5)
        Sleep 1200
        return true
    }

    return false
}

SearchContact(contactName) {
    ; Abrir búsqueda
    Send("^f")
    Sleep 500

    ; Limpiar búsqueda
    Send("^a")
    Sleep 150
    Send("{Backspace}")
    Sleep 250

    ; Escribir nombre del contacto
    SendText(contactName)
    Sleep 1200

    ; Entrar al chat
    Send("{Enter}")
    Sleep 1200
}

SendMessageText(text) {
    ; Escribe y envía el mensaje
    SendText(text)
    Sleep 400
    Send("{Enter}")
    Sleep 500
}

ok := ActivateWhatsApp()

if (!ok) {
    MsgBox "No pude abrir o detectar WhatsApp Desktop."
    ExitApp
}

SearchContact(contact)
SendMessageText(message)

ExitApp