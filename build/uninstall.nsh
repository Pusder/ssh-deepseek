/**
 * 卸载时的自定义逻辑（NSIS include，由 electron-builder 插入到 uninstaller.nsh 的
 * ${customUnInstall} 位置）。
 *
 * 目标：卸载时询问用户是否一并删除「深寻 SSH」在 Roaming 目录下的配置数据
 *       （配置、加密后的密码、已信任主机指纹等）。
 *
 * 必要处理：
 *   1. 静默卸载（/S）无法弹窗，直接跳过询问，保留用户数据；
 *   2. 覆盖安装/自动更新时 electron-builder 会传 KEEP_APP_DATA，此时必须跳过询问；
 *   3. electron-builder 自带的数据删除只在 deleteAppDataOnUninstall=true 或
 *      显式传入 --delete-app-data 时执行；本工程两项都不满足，因此完全由此处接管；
 *   4. 目录名取自 APP_PRODUCT_FILENAME / APP_FILENAME（即 productName / name），
 *      与应用 app.getPath('userData') 指向的目录一致，另附常见目录名兜底。
 */

!macro customUnInstall
  # 静默卸载不询问
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
    # 更新/覆盖安装时保留数据，不打扰用户
    ${GetOptions} $R0 "KEEP_APP_DATA" $R2
    ${If} ${Errors}
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "是否同时删除「深寻 SSH」的配置数据？$\r$\n$\r$\n包含已保存的服务器配置、加密后的密码以及已信任的主机指纹，删除后无法恢复。$\r$\n$\r$\n选择「否」将保留这些数据，便于日后重新安装时继续使用。" \
        /SD IDNO \
        IDYES deleteAppData IDNO keepAppData

      deleteAppData:
        # Electron 始终使用「每用户」数据目录
        ${If} $installMode == "all"
          SetShellVarContext current
        ${EndIf}
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        RMDir /r "$APPDATA\${APP_FILENAME}"
        # 兜底：产品名与实际目录名不一致时，再尝试常见名称
        RMDir /r "$APPDATA\深寻SSH"
        RMDir /r "$APPDATA\深寻 SSH"
        RMDir /r "$APPDATA\deepseek-ssh"
        # 缓存在 LocalAppData 下，一并清理
        RMDir /r "$LOCALAPPDATA\${APP_PRODUCT_FILENAME}"
        RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
        RMDir /r "$LOCALAPPDATA\深寻SSH"
        RMDir /r "$LOCALAPPDATA\深寻 SSH"
        DetailPrint "已删除配置数据"
        Goto done

      keepAppData:
        DetailPrint "已保留配置数据"

      done:
    ${EndIf}
  ${EndIf}
!macroend
