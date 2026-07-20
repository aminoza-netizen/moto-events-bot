# Один раз на VM: включает OpenSSH и даёт Claude доступ по ключу для обслуживания бота.
# Запуск: правой кнопкой по PowerShell → "Запуск от имени администратора", затем:
#   powershell -ExecutionPolicy Bypass -File enable-ssh.ps1

Write-Host "Устанавливаю OpenSSH Server..."
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

Write-Host "Запускаю службу sshd (и в автозагрузку)..."
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

Write-Host "Открываю порт 22 в фаерволе..."
if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

Write-Host "Добавляю ключ доступа..."
$key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICw4q5xv6B2Bpg7aDK5B1Qv6VqqXEPJFdkoaRFzFb2yR claude-moto-bot'
$authFile = 'C:\ProgramData\ssh\administrators_authorized_keys'
if (-not (Test-Path $authFile) -or -not (Select-String -Path $authFile -Pattern 'claude-moto-bot' -Quiet)) {
  Add-Content -Path $authFile -Value $key
}
icacls $authFile /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

Restart-Service sshd
Write-Host ""
Write-Host "ГОТОВО. SSH включён, ключ добавлен." -ForegroundColor Green
Write-Host "Имя пользователя Windows (понадобится Claude):" $env:USERNAME
