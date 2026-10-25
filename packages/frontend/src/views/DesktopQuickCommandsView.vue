 <template>
  <div class="relative flex flex-col h-full overflow-hidden bg-background">
    <!-- Container for controls and list -->
    <div class="flex flex-col flex-grow overflow-hidden bg-background">
      <!-- Controls Area -->
      <div class="flex items-center p-2  flex-shrink-0 gap-2 bg-background"> <!-- Reduced padding p-3 to p-2 -->
        <input
          type="text"
          :placeholder="$t('quickCommands.searchPlaceholder', '搜索名称或指令...')"
          :value="localSearchTerm"
          data-focus-id="quickCommandsSearch"
          @input="updateSearchTerm($event)"
          @keydown="handleSearchInputKeydown"
          @blur="handleSearchInputBlur"
          ref="searchInputRef"
          class="flex-grow min-w-0 px-4 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out"
        />
        <!-- Sort Button -->
        <button @click="toggleSortBy" class="w-8 h-8 border border-border/50 rounded-lg text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0 flex items-center justify-center" :title="sortButtonTitle">
          <i :class="[sortButtonIcon, 'text-base']"></i>
        </button>
        <!-- View Mode Toggle Button (Grid / List / Pills) -->
        <button @click="cycleViewMode"
                class="w-8 h-8 border border-border/50 rounded-lg text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0 flex items-center justify-center cursor-pointer"
                :class="{ 'bg-primary/20 text-primary border-primary/40': currentViewMode !== 'list' }"
                :title="viewModeTitle">
          <i :class="['fas', viewModeIcon, 'text-base']"></i>
        </button>
        <!-- Folder Layout Toggle Button (Accordion / Sidebar) -->
        <button @click="toggleFolderLayoutMode"
                class="w-8 h-8 border border-border/50 rounded-lg text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0 flex items-center justify-center cursor-pointer"
                :class="{ 'bg-primary/20 text-primary border-primary/40': folderLayoutMode === 'sidebar' }"
                :title="folderLayoutTitle">
          <i :class="['fas', folderLayoutMode === 'sidebar' ? 'fa-table-columns' : 'fa-folder-tree', 'text-sm']"></i>
        </button>
        <!-- New Folder Button -->
        <button @click="openCreateFolderDialog"
                class="w-8 h-8 border border-border/50 rounded-lg text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0 flex items-center justify-center cursor-pointer"
                :title="t('folders.newFolder', '新建文件夹')">
          <i class="fas fa-folder-plus text-sm text-amber-400"></i>
        </button>
        <!-- Add Button -->
        <button @click="openAddForm" class="w-8 h-8 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary flex-shrink-0 flex items-center justify-center" :title="$t('quickCommands.add', '添加快捷指令')">
          <i class="fas fa-plus text-base"></i>
        </button>
      </div>
      <!-- 1. 侧栏文件夹视图模式 (Sidebar Layout Mode) -->
      <div v-if="folderLayoutMode === 'sidebar'" class="flex flex-row flex-grow overflow-hidden min-h-0 bg-background">
        <!-- 左侧：文件夹导航侧栏 -->
        <aside
          class="border-r border-border/50 flex flex-col flex-shrink-0 overflow-hidden bg-header/20 select-none relative"
          :style="{ width: `${sidebarWidth}px` }"
        >
          <div class="flex-grow overflow-y-auto p-1.5 space-y-0.5">
            <!-- 全部指令条目 -->
            <div
              @click="sidebarActiveFolderId = 'all'"
              class="flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer text-xs transition-colors duration-150 min-h-[30px]"
              :class="sidebarActiveFolderId === 'all' ? 'bg-primary/15 text-primary font-semibold' : 'text-foreground/80 hover:text-foreground hover:bg-header/60'"
            >
              <div class="flex items-center gap-2 truncate min-w-0 pr-1.5">
                <i class="fas fa-layer-group text-xs text-primary/80 flex-shrink-0"></i>
                <span class="truncate">{{ t('quickCommands.allCommands', '全部指令') }}</span>
              </div>
              <span class="text-[11px] px-1.5 py-0.2 rounded-full bg-border/40 text-text-secondary font-mono flex-shrink-0">
                {{ getFolderCommandCount('all') }}
              </span>
            </div>

            <!-- 分类文件夹列表 -->
            <div
              v-for="folder in quickCommandFoldersStore.folders"
              :key="folder.id"
              @click="editingFolderId !== folder.id ? (sidebarActiveFolderId = folder.id) : null"
              @contextmenu.prevent="showFolderContextMenu($event, folder)"
              class="group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer text-xs transition-colors duration-150 relative min-h-[30px]"
              :class="sidebarActiveFolderId === folder.id ? 'bg-primary/15 text-primary font-semibold' : 'text-foreground/80 hover:text-foreground hover:bg-header/60'"
              :title="folder.name"
            >
              <!-- 编辑状态 -->
              <input
                v-if="editingFolderId === folder.id"
                :key="`sidebar-folder-${folder.id}`"
                :ref="(el) => setFolderInputRef(el, folder.id)"
                type="text"
                v-model="editedFolderName"
                class="bg-input border border-primary rounded px-1.5 py-0.5 w-full text-xs text-foreground focus:outline-none"
                @blur="finishEditingFolder"
                @keydown.enter.prevent="finishEditingFolder"
                @keydown.esc.prevent="cancelEditingFolder"
                @click.stop
              />
              <!-- 正常展示状态 -->
              <template v-else>
                <div class="flex items-center gap-2 truncate min-w-0 flex-1 pr-1.5">
                  <i
                    class="fas fa-folder text-xs flex-shrink-0 transition-colors"
                    :class="folder.background_color ? '' : 'text-amber-400'"
                    :style="folder.background_color ? { color: folder.background_color } : {}"
                  ></i>
                  <span class="truncate">{{ folder.name }}</span>
                </div>

                <!-- 右侧容器：宽侧栏时hover渐变显示3个按钮；窄侧栏时只显示数字角标，绝不与文本重叠！ -->
                <div class="flex items-center justify-end flex-shrink-0 relative min-w-[20px]" @click.stop>
                  <!-- 数量角标 (过窄时常驻且不淡出；宽侧栏时hover淡出) -->
                  <span
                    class="text-[11px] px-1.5 py-0.2 rounded-full bg-border/40 text-text-secondary font-mono flex-shrink-0 transition-opacity duration-150"
                    :class="{ 'group-hover:opacity-0 group-hover:pointer-events-none': !isNarrowSidebar }"
                  >
                    {{ getFolderCommandCount(folder.id) }}
                  </span>

                  <!-- 悬浮操作按钮 (仅在非过窄模式下提供 hover 显示，过窄模式完全不渲染，避免文本重叠) -->
                  <div
                    v-if="!isNarrowSidebar"
                    class="absolute right-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none group-hover:pointer-events-auto bg-inherit rounded-md"
                  >
                    <!-- 调色板 -->
                    <div class="relative inline-flex items-center" @click.stop>
                      <button
                        @click.stop="toggleFolderColorPicker(folder.id, $event)"
                        class="w-5 h-5 p-0 rounded text-text-secondary hover:text-foreground hover:bg-muted text-[10px] flex items-center justify-center cursor-pointer"
                        :title="t('folders.folderColor', '文件夹背景颜色')"
                      >
                        <i class="fas fa-palette"></i>
                      </button>
                      <ColorPickerPopover
                        :visible="activeFolderColorPickerId === folder.id"
                        :trigger-el="activeFolderColorPickerTriggerEl"
                        :model-value="folder.background_color || null"
                        @update:model-value="handleUpdateFolderColor(folder.id, $event)"
                        @close="activeFolderColorPickerId = null; activeFolderColorPickerTriggerEl = null"
                      />
                    </div>
                    <!-- 重命名 -->
                    <button
                      @click.stop="startEditingFolder(folder.id, folder.name)"
                      class="w-5 h-5 p-0 rounded text-text-secondary hover:text-foreground hover:bg-muted text-[10px] flex items-center justify-center cursor-pointer"
                      :title="t('folders.renameFolder', '重命名文件夹')"
                    >
                      <i class="fas fa-pencil-alt"></i>
                    </button>
                    <!-- 删除 -->
                    <button
                      @click.stop="handleDeleteFolder(folder.id, folder.name, $event)"
                      class="w-5 h-5 p-0 rounded text-text-secondary hover:text-error hover:bg-muted text-[10px] flex items-center justify-center cursor-pointer"
                      :title="t('folders.deleteFolder', '删除文件夹')"
                    >
                      <i class="fas fa-trash-alt"></i>
                    </button>
                  </div>
                </div>
              </template>
            </div>

            <!-- 未分类文件夹 -->
            <div
              v-if="getFolderCommandCount('untagged') > 0"
              @click="sidebarActiveFolderId = 'untagged'"
              class="flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer text-xs transition-colors duration-150 min-h-[30px]"
              :class="sidebarActiveFolderId === 'untagged' ? 'bg-primary/15 text-primary font-semibold' : 'text-foreground/80 hover:text-foreground hover:bg-header/60'"
            >
              <div class="flex items-center gap-2 truncate min-w-0 pr-1.5">
                <i class="fas fa-inbox text-xs text-text-secondary flex-shrink-0"></i>
                <span class="truncate">{{ t('quickCommands.untagged', '未分类') }}</span>
              </div>
              <span class="text-[11px] px-1.5 py-0.2 rounded-full bg-border/40 text-text-secondary font-mono flex-shrink-0">
                {{ getFolderCommandCount('untagged') }}
              </span>
            </div>
          </div>

          <!-- 侧栏底部：新建文件夹快捷入口 -->
          <div class="p-1.5 border-t border-border/40 flex-shrink-0">
            <button
              @click="openCreateFolderDialog"
              class="w-full flex items-center justify-center gap-1.5 py-1.5 px-2 text-xs text-text-secondary hover:text-foreground hover:bg-header/60 rounded-lg border border-dashed border-border/60 transition-colors cursor-pointer"
            >
              <i class="fas fa-folder-plus text-amber-400 text-xs"></i>
              <span>{{ t('folders.newFolder', '新建文件夹') }}</span>
            </button>
          </div>
        </aside>

        <!-- 侧栏拖拽调整宽度手柄 -->
        <div
          class="w-1.5 -ml-1 z-10 cursor-col-resize flex-shrink-0 flex items-center justify-center group select-none hover:bg-primary/40 active:bg-primary transition-colors duration-150"
          :class="{ 'bg-primary/60': isDraggingSidebar }"
          @mousedown="startResizeSidebar"
          :title="t('quickCommands.dragResize', '拖动调整宽度')"
        >
          <div class="w-0.5 h-6 rounded-full bg-border/60 group-hover:bg-primary transition-colors"></div>
        </div>

        <!-- 右侧：指令展示区域 -->
        <main class="flex-1 flex flex-col min-w-0 overflow-hidden">
          <!-- 右侧顶部文件夹栏 -->
          <div class="flex items-center justify-between px-3 py-1.5 border-b border-border/40 text-xs flex-shrink-0 bg-background/50">
            <div class="flex items-center gap-2 truncate min-w-0">
              <i
                v-if="sidebarActiveFolderId === 'all'"
                class="fas fa-layer-group text-primary text-xs flex-shrink-0"
              ></i>
              <i
                v-else-if="sidebarActiveFolderId === 'untagged'"
                class="fas fa-inbox text-text-secondary text-xs flex-shrink-0"
              ></i>
              <i
                v-else
                class="fas fa-folder-open text-xs flex-shrink-0 transition-colors"
                :class="activeSidebarFolderColor ? '' : 'text-amber-400'"
                :style="activeSidebarFolderColor ? { color: activeSidebarFolderColor } : {}"
              ></i>
              <span class="font-semibold text-foreground truncate">{{ activeSidebarFolderName }}</span>
              <span class="text-text-secondary font-mono text-[11px]">({{ sidebarDisplayCommands.length }})</span>

              <!-- 侧栏过窄时的补充操作按钮组 -->
              <div
                v-if="isNarrowSidebar && typeof sidebarActiveFolderId === 'number'"
                class="flex items-center gap-0.5 ml-2 pl-2 border-l border-border/50"
              >
                <!-- 调色板 -->
                <div class="relative inline-flex items-center">
                  <button
                    @click="toggleFolderColorPicker(sidebarActiveFolderId, $event)"
                    class="w-5 h-5 rounded text-text-secondary hover:text-foreground hover:bg-muted text-[10px] flex items-center justify-center cursor-pointer"
                    :title="t('folders.folderColor', '文件夹背景颜色')"
                  >
                    <i class="fas fa-palette"></i>
                  </button>
                  <ColorPickerPopover
                    :visible="activeFolderColorPickerId === sidebarActiveFolderId"
                    :trigger-el="activeFolderColorPickerTriggerEl"
                    :model-value="activeSidebarFolderColor"
                    @update:model-value="handleUpdateFolderColor(sidebarActiveFolderId, $event)"
                    @close="activeFolderColorPickerId = null; activeFolderColorPickerTriggerEl = null"
                  />
                </div>
                <!-- 重命名 -->
                <button
                  @click="startEditingFolder(sidebarActiveFolderId, activeSidebarFolderName)"
                  class="w-5 h-5 rounded text-text-secondary hover:text-foreground hover:bg-muted text-[10px] flex items-center justify-center cursor-pointer"
                  :title="t('folders.renameFolder', '重命名文件夹')"
                >
                  <i class="fas fa-pencil-alt"></i>
                </button>
                <!-- 删除 -->
                <button
                  @click="handleDeleteFolder(sidebarActiveFolderId, activeSidebarFolderName, $event)"
                  class="w-5 h-5 rounded text-text-secondary hover:text-error hover:bg-muted text-[10px] flex items-center justify-center cursor-pointer"
                  :title="t('folders.deleteFolder', '删除文件夹')"
                >
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>
            </div>
            <button
              @click="openAddForm(typeof sidebarActiveFolderId === 'number' ? sidebarActiveFolderId : null)"
              class="text-xs text-primary hover:text-primary-hover flex items-center gap-1 cursor-pointer font-medium"
            >
              <i class="fas fa-plus text-[10px]"></i>
              <span>{{ t('quickCommands.add', '添加指令') }}</span>
            </button>
          </div>

          <!-- 右侧指令列表滚动容器 -->
          <div
            class="flex-grow overflow-y-auto p-2"
            tabindex="0"
            @wheel.ctrl.prevent="handleWheel"
            :style="{ '--qc-row-size-multiplier': quickCommandRowSizeMultiplier }"
          >
            <!-- Loading 状态 -->
            <div v-if="isLoading && quickCommandsStore.quickCommandsList.length === 0" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
              <i class="fas fa-spinner fa-spin text-xl mb-2"></i>
              <p>{{ t('common.loading', '加载中...') }}</p>
            </div>
            <!-- Empty 状态 (当前文件夹无指令) -->
            <div v-else-if="sidebarDisplayCommands.length === 0" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
              <i class="fas fa-search text-xl mb-2" v-if="searchTerm"></i>
              <i class="fas fa-folder-open text-xl mb-2 text-text-secondary/60" v-else></i>
              <p class="mb-3">
                {{ searchTerm ? `${t('quickCommands.noResults', '没有找到匹配的指令')} "${searchTerm}"` : t('quickCommands.empty', '该文件夹下没有快捷指令。') }}
              </p>
              <button
                v-if="!searchTerm"
                @click="openAddForm(typeof sidebarActiveFolderId === 'number' ? sidebarActiveFolderId : null)"
                class="px-3 py-1.5 bg-primary text-white border-none rounded-lg text-xs font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-primary-dark"
              >
                {{ $t('quickCommands.add', '添加快捷指令') }}
              </button>
            </div>

            <!-- 卡片列表渲染 (基于 currentViewMode) -->
            <div v-else class="list-none p-0 m-0 outline-none">
              <!-- 1. 网格卡片模式 (Grid) -->
              <div v-if="currentViewMode === 'grid'" class="qc-grid-container pl-1 pr-1">
                <div
                  v-for="(cmd) in sidebarDisplayCommands"
                  :key="cmd.id"
                  :data-command-id="cmd.id"
                  class="group flex items-center justify-between cursor-pointer rounded-lg border border-border/50 bg-header/40 hover:bg-primary/10 hover:border-primary/50 transition-all duration-150 select-none overflow-hidden"
                  :class="{ 'bg-primary/20 border-primary font-medium': isCommandSelected(cmd.id) }"
                  :style="[
                    { padding: `calc(0.4rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))` },
                    getCommandCardStyle(cmd, typeof sidebarActiveFolderId === 'number' ? sidebarActiveFolderId : null)
                  ]"
                  @click="handleCommandItemClick(cmd)"
                  @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                  :title="getCommandTooltip(cmd)"
                >
                  <div class="flex-1 min-w-0 flex flex-col justify-center gap-0.5 mr-1.5">
                    <div class="flex items-center text-foreground truncate"
                         :style="{ fontSize: `calc(0.82em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                      <i class="fas fa-terminal text-primary text-[10px] mr-1.5 flex-shrink-0"></i>
                      <span class="font-medium truncate">{{ cmd.name || cmd.command }}</span>
                    </div>
                    <div v-if="cmd.name && cmd.command"
                         class="truncate font-mono text-text-secondary"
                         :style="{ fontSize: `calc(0.7em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                      {{ cmd.command }}
                    </div>
                  </div>
                  <div class="flex items-center flex-shrink-0">
                    <button
                      type="button"
                      @click.stop="executeCommand(cmd)"
                      class="rounded-md flex items-center justify-center text-primary bg-primary/15 border border-primary/25 group-hover:bg-primary group-hover:text-white transition-all duration-150"
                      :style="{
                        width: `calc(1.35rem * var(--qc-row-size-multiplier))`,
                        height: `calc(1.35rem * var(--qc-row-size-multiplier))`
                      }"
                      :title="t('quickCommands.form.execute', '执行')"
                    >
                      <i class="fas fa-play text-[9px]"></i>
                    </button>
                  </div>
                </div>
              </div>

              <!-- 2. 药丸流式模式 (Pills) -->
              <div v-else-if="currentViewMode === 'pills'" class="qc-pill-container pl-1 pr-1">
                <div
                  v-for="(cmd) in sidebarDisplayCommands"
                  :key="cmd.id"
                  :data-command-id="cmd.id"
                  class="group inline-flex items-center cursor-pointer rounded-md border border-border/50 bg-header/40 hover:bg-primary/15 hover:border-primary/50 hover:text-primary text-foreground transition-all duration-150 select-none"
                  :class="{ 'bg-primary/25 border-primary text-primary font-medium': isCommandSelected(cmd.id) }"
                  :style="[
                    {
                      padding: `calc(0.2rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))`,
                      fontSize: `calc(0.78em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))`
                    },
                    getCommandCardStyle(cmd, typeof sidebarActiveFolderId === 'number' ? sidebarActiveFolderId : null)
                  ]"
                  @click="handleCommandItemClick(cmd)"
                  @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                  :title="getCommandTooltip(cmd)"
                >
                  <i class="fas fa-bolt text-amber-500 text-[10px] mr-1.5 flex-shrink-0"></i>
                  <span class="truncate max-w-[220px]">{{ cmd.name || cmd.command }}</span>
                </div>
              </div>

              <!-- 3. 标准列表模式 (List) -->
              <ul v-else class="list-none p-0 m-0 pl-1 pr-1">
                <li
                  v-for="(cmd) in sidebarDisplayCommands"
                  :key="cmd.id"
                  :data-command-id="cmd.id"
                  class="group flex justify-between items-center mb-1 cursor-pointer rounded-md hover:bg-primary/10 transition-colors duration-150"
                  :style="[
                    { padding: `calc(0.625rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` },
                    getCommandCardStyle(cmd, typeof sidebarActiveFolderId === 'number' ? sidebarActiveFolderId : null)
                  ]"
                  :class="{ 'bg-primary/20 font-medium': isCommandSelected(cmd.id) }"
                  @click="handleCommandItemClick(cmd)"
                  @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                >
                  <div class="flex flex-col overflow-hidden mr-2 flex-grow">
                    <span v-if="cmd.name"
                          class="font-medium truncate text-foreground mb-0.5"
                          :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.name }}</span>
                    <span v-if="cmd.command"
                          class="truncate font-mono"
                          :class="{ 'text-sm': !cmd.name, 'text-text-secondary': true }"
                          :style="{ fontSize: `calc(0.75em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.command }}</span>
                  </div>
                  <div class="flex items-center flex-shrink-0 opacity-100">
                    <button @click.stop="copyCommand(cmd.command)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('commandHistory.copy', '复制')">
                      <i class="fas fa-copy" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                    </button>
                    <button @click.stop="openEditForm(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('common.edit', '编辑')">
                      <i class="fas fa-edit" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                    </button>
                    <button @click.stop="confirmDelete(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-error" :title="$t('common.delete', '删除')">
                      <i class="fas fa-times" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </main>
      </div>

      <!-- 2. 折叠树模式 (Accordion Layout Mode) -->
      <div v-else class="flex-grow overflow-y-auto p-2">
        <!-- Loading State -->
        <div v-if="isLoading && quickCommandsStore.quickCommandsList.length === 0" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
            <i class="fas fa-spinner fa-spin text-xl mb-2"></i>
            <p>{{ t('common.loading', '加载中...') }}</p>
        </div>
        <!-- Empty State (No commands at all) -->
        <div v-else-if="!isLoading && quickCommandsStore.quickCommandsList.length === 0" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
            <i class="fas fa-bolt text-xl mb-2"></i>
            <p class="mb-3">{{ $t('quickCommands.empty', '没有快捷指令。') }}</p>
            <button @click="openAddForm" class="px-4 py-2 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary">
             {{ $t('quickCommands.addFirst', '创建第一个快捷指令') }}
           </button>
       </div>
        <!-- No Results State (Commands exist, but filter yields no results) -->
        <div v-else-if="!isLoading && ((showQuickCommandFoldersBoolean && filteredAndGroupedCommands.length === 0) || (!showQuickCommandFoldersBoolean && flatFilteredCommands.length === 0)) && searchTerm" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
            <i class="fas fa-search text-xl mb-2"></i>
            <p>{{ t('quickCommands.noResults', '没有找到匹配的指令') }} "{{ searchTerm }}"</p>
        </div>

       <!-- Command List (Grouped or Flat) -->
       <div
        v-else
        class="list-none p-0 m-0 outline-none"
        ref="commandListContainerRef"
        tabindex="0"
        @wheel.ctrl.prevent="handleWheel"
        :style="{ '--qc-row-size-multiplier': quickCommandRowSizeMultiplier }"
        @keydown="handleSearchInputKeydown"
       >
            <!-- Grouped View -->
            <div v-if="showQuickCommandFoldersBoolean">
                <div v-for="groupData in filteredAndGroupedCommands" :key="groupData.groupName" class="mb-1 last:mb-0">
                    <div
                        class="group font-semibold flex items-center justify-between text-foreground rounded-lg hover:bg-header/80 transition-colors duration-150 h-9 min-h-[36px] max-h-[36px] box-border"
                        :style="{ padding: isCompactMode ? `0 calc(0.6rem * var(--qc-row-size-multiplier))` : `0 calc(0.7rem * var(--qc-row-size-multiplier))` }"
                        :class="{ 'cursor-pointer': editingFolderId !== (groupData.folderId === null ? 'untagged' : groupData.folderId) }"
                        @click="editingFolderId !== (groupData.folderId === null ? 'untagged' : groupData.folderId) ? toggleGroup(groupData.groupName) : null"
                    >
                        <div class="flex items-center min-w-0 flex-1 mr-2">
                            <i
                                :class="['fas', expandedGroups[groupData.groupName] ? 'fa-chevron-down' : 'fa-chevron-right', 'mr-2 w-3.5 text-center text-text-secondary group-hover:text-foreground transition-transform duration-200 ease-in-out', {'transform rotate-0': !expandedGroups[groupData.groupName]}]"
                                :style="{ fontSize: `calc(0.75em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"
                                @click.stop="toggleGroup(groupData.groupName)"
                                class="cursor-pointer flex-shrink-0"
                            ></i>

                            <!-- Folder Icon -->
                            <i
                                :class="[
                                    'fas mr-2 w-4 text-center flex-shrink-0 transition-colors',
                                    groupData.folderId === null
                                        ? 'fa-inbox text-text-secondary'
                                        : (expandedGroups[groupData.groupName] ? 'fa-folder-open' : 'fa-folder'),
                                    (!getFolderColorById(groupData.folderId) && groupData.folderId !== null) ? 'text-amber-400' : ''
                                ]"
                                :style="{
                                    color: getFolderColorById(groupData.folderId) || undefined,
                                    fontSize: `calc(0.9em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))`
                                }"
                            ></i>

                            <!-- Editing State -->
                            <input
                                v-if="editingFolderId === (groupData.folderId === null ? 'untagged' : groupData.folderId)"
                                :key="groupData.folderId === null ? 'untagged-input' : `folder-input-${groupData.folderId}`"
                                :ref="(el) => setFolderInputRef(el, groupData.folderId === null ? 'untagged' : groupData.folderId)"
                                type="text"
                                v-model="editedFolderName"
                                class="bg-input border border-primary rounded px-1.5 py-0.5 w-full text-xs text-foreground focus:outline-none"
                                @blur="finishEditingFolder"
                                @keydown.enter.prevent="finishEditingFolder"
                                @keydown.esc.prevent="cancelEditingFolder"
                                @click.stop
                            />
                            <!-- Display State -->
                            <div v-else class="flex items-center gap-2 truncate min-w-0">
                                <span
                                    class="inline-block overflow-hidden text-ellipsis whitespace-nowrap text-xs md:text-sm"
                                    :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"
                                >
                                    {{ groupData.groupName }}
                                </span>
                                <span class="text-[11px] text-text-secondary font-normal flex-shrink-0">({{ groupData.commands.length }})</span>
                            </div>
                        </div>

                        <!-- Actions for Folder (常驻占位防抖动，仅透明度过渡) -->
                        <div
                            v-if="groupData.folderId !== null && editingFolderId !== groupData.folderId"
                            class="flex items-center gap-0.5 flex-shrink-0 h-6 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none group-hover:pointer-events-auto"
                            @click.stop
                        >
                            <!-- Folder Color Picker -->
                            <div v-if="groupData.folderId !== null" class="relative inline-flex items-center" @click.stop>
                                <button
                                    @click.stop="toggleFolderColorPicker(groupData.folderId, $event)"
                                    class="w-6 h-6 p-0 rounded text-text-secondary hover:text-foreground hover:bg-muted text-xs transition-colors flex items-center justify-center cursor-pointer"
                                    :title="t('folders.folderColor', '文件夹背景颜色')"
                                >
                                    <i class="fas fa-palette text-[10px]"></i>
                                </button>
                                <ColorPickerPopover
                                    :visible="activeFolderColorPickerId === groupData.folderId"
                                    :trigger-el="activeFolderColorPickerTriggerEl"
                                    :model-value="getFolderColorById(groupData.folderId)"
                                    @update:model-value="handleUpdateFolderColor(groupData.folderId, $event)"
                                    @close="activeFolderColorPickerId = null; activeFolderColorPickerTriggerEl = null"
                                />
                            </div>
                            <button
                                v-if="groupData.folderId !== null"
                                @click="startEditingFolder(groupData.folderId, groupData.groupName)"
                                class="w-6 h-6 p-0 rounded text-text-secondary hover:text-foreground hover:bg-muted text-xs transition-colors flex items-center justify-center cursor-pointer"
                                :title="t('folders.renameFolder', '重命名文件夹')"
                            >
                                <i class="fas fa-pencil-alt text-[10px]"></i>
                            </button>
                            <button
                                v-if="groupData.folderId !== null"
                                @click="handleDeleteFolder(groupData.folderId, groupData.groupName, $event)"
                                class="w-6 h-6 p-0 rounded text-text-secondary hover:text-error hover:bg-muted text-xs transition-colors flex items-center justify-center cursor-pointer"
                                :title="t('folders.deleteFolder', '删除文件夹')"
                            >
                                <i class="fas fa-trash-alt text-[10px]"></i>
                            </button>
                        </div>
                    </div>
                    <!-- Command Items List (only show if expanded) -->
                    <!-- Command Items List (only show if expanded) -->
                    <div v-show="quickCommandsStore.expandedGroups[groupData.groupName]" class="mt-1">
                        <!-- 1. 网格卡片模式 (Grid) -->
                        <div v-if="currentViewMode === 'grid'" class="qc-grid-container pl-3 pr-1 mb-2">
                            <div
                                v-for="(cmd) in groupData.commands"
                                :key="cmd.id"
                                :data-command-id="cmd.id"
                                class="group flex items-center justify-between cursor-pointer rounded-lg border border-border/50 bg-header/40 hover:bg-primary/10 hover:border-primary/50 transition-all duration-150 select-none overflow-hidden"
                                :class="{ 'bg-primary/20 border-primary font-medium': isCommandSelected(cmd.id) }"
                                :style="[
                                    { padding: `calc(0.4rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))` },
                                    getCommandCardStyle(cmd, groupData.folderId)
                                ]"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                :title="getCommandTooltip(cmd)"
                            >
                                <div class="flex-1 min-w-0 flex flex-col justify-center gap-0.5 mr-1.5">
                                    <div class="flex items-center text-foreground truncate"
                                         :style="{ fontSize: `calc(0.82em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                        <i class="fas fa-terminal text-primary text-[10px] mr-1.5 flex-shrink-0"></i>
                                        <span class="font-medium truncate">{{ cmd.name || cmd.command }}</span>
                                    </div>
                                    <div v-if="cmd.name && cmd.command"
                                         class="truncate font-mono text-text-secondary"
                                         :style="{ fontSize: `calc(0.7em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                        {{ cmd.command }}
                                    </div>
                                </div>
                                <div class="flex items-center flex-shrink-0">
                                    <button
                                        type="button"
                                        @click.stop="executeCommand(cmd)"
                                        class="rounded-md flex items-center justify-center text-primary bg-primary/15 border border-primary/25 group-hover:bg-primary group-hover:text-white transition-all duration-150"
                                        :style="{
                                            width: `calc(1.35rem * var(--qc-row-size-multiplier))`,
                                            height: `calc(1.35rem * var(--qc-row-size-multiplier))`
                                        }"
                                        :title="t('quickCommands.form.execute', '执行')"
                                    >
                                        <i class="fas fa-play text-[9px]"></i>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- 2. 药丸流式模式 (Pills) -->
                        <div v-else-if="currentViewMode === 'pills'" class="qc-pill-container pl-3 pr-1 mb-2">
                            <div
                                v-for="(cmd) in groupData.commands"
                                :key="cmd.id"
                                :data-command-id="cmd.id"
                                class="group inline-flex items-center cursor-pointer rounded-md border border-border/50 bg-header/40 hover:bg-primary/15 hover:border-primary/50 hover:text-primary text-foreground transition-all duration-150 select-none"
                                :class="{ 'bg-primary/25 border-primary text-primary font-medium': isCommandSelected(cmd.id) }"
                                :style="[
                                    {
                                        padding: `calc(0.2rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))`,
                                        fontSize: `calc(0.78em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))`
                                    },
                                    getCommandCardStyle(cmd, groupData.folderId)
                                ]"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                :title="getCommandTooltip(cmd)"
                            >
                                <i class="fas fa-bolt text-amber-500 text-[10px] mr-1.5 flex-shrink-0"></i>
                                <span class="truncate max-w-[220px]">{{ cmd.name || cmd.command }}</span>
                            </div>
                        </div>

                        <!-- 3. 标准列表模式 (List) -->
                        <ul v-else class="list-none p-0 m-0 pl-3">
                            <li
                                v-for="(cmd) in groupData.commands"
                                :key="cmd.id"
                                :data-command-id="cmd.id"
                                class="group flex justify-between items-center mb-1 cursor-pointer rounded-md hover:bg-primary/10 transition-colors duration-150"
                                :style="[
                                    { padding: `calc(0.625rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` },
                                    getCommandCardStyle(cmd, groupData.folderId)
                                ]"
                                :class="{ 'bg-primary/20 font-medium': isCommandSelected(cmd.id) }"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                            >
                                <div class="flex flex-col overflow-hidden mr-2 flex-grow">
                                    <span v-if="cmd.name"
                                          class="font-medium truncate text-foreground mb-0.5"
                                          :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.name }}</span>
                                    <span v-if="cmd.command"
                                          class="truncate font-mono"
                                          :class="{ 'text-sm': !cmd.name, 'text-text-secondary': true }"
                                          :style="{ fontSize: `calc(0.75em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.command }}</span>
                                </div>
                                <div class="flex items-center flex-shrink-0 opacity-100">
                                    <button @click.stop="copyCommand(cmd.command)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('commandHistory.copy', '复制')">
                                        <i class="fas fa-copy" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                                    </button>
                                    <button @click.stop="openEditForm(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('common.edit', '编辑')">
                                        <i class="fas fa-edit" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                                    </button>
                                    <button @click.stop="confirmDelete(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-error" :title="$t('common.delete', '删除')">
                                        <i class="fas fa-times" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                                    </button>
                                </div>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            <!-- Flat View (无标签扁平视图) -->
            <div v-else>
                <!-- 1. 网格卡片模式 (Grid) -->
                <div v-if="currentViewMode === 'grid'" class="qc-grid-container pl-1 pr-1">
                    <div
                        v-for="(cmd) in flatFilteredCommands"
                        :key="cmd.id"
                        :data-command-id="cmd.id"
                        class="group flex items-center justify-between cursor-pointer rounded-lg border border-border/50 bg-header/40 hover:bg-primary/10 hover:border-primary/50 transition-all duration-150 select-none overflow-hidden"
                        :class="{ 'bg-primary/20 border-primary font-medium': isCommandSelected(cmd.id) }"
                        :style="[
                            { padding: `calc(0.4rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))` },
                            getCommandCardStyle(cmd, null)
                        ]"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                        :title="getCommandTooltip(cmd)"
                    >
                        <div class="flex-1 min-w-0 flex flex-col justify-center gap-0.5 mr-1.5">
                            <div class="flex items-center text-foreground truncate"
                                 :style="{ fontSize: `calc(0.82em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                <i class="fas fa-terminal text-primary text-[10px] mr-1.5 flex-shrink-0"></i>
                                <span class="font-medium truncate">{{ cmd.name || cmd.command }}</span>
                            </div>
                            <div v-if="cmd.name && cmd.command"
                                 class="truncate font-mono text-text-secondary"
                                 :style="{ fontSize: `calc(0.7em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                {{ cmd.command }}
                            </div>
                        </div>
                        <div class="flex items-center flex-shrink-0">
                            <button
                                type="button"
                                @click.stop="executeCommand(cmd)"
                                class="rounded-md flex items-center justify-center text-primary bg-primary/15 border border-primary/25 group-hover:bg-primary group-hover:text-white transition-all duration-150"
                                :style="{
                                    width: `calc(1.35rem * var(--qc-row-size-multiplier))`,
                                    height: `calc(1.35rem * var(--qc-row-size-multiplier))`
                                }"
                                :title="t('quickCommands.form.execute', '执行')"
                            >
                                <i class="fas fa-play text-[9px]"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 2. 药丸流式模式 (Pills) -->
                <div v-else-if="currentViewMode === 'pills'" class="qc-pill-container pl-1 pr-1">
                    <div
                        v-for="(cmd) in flatFilteredCommands"
                        :key="cmd.id"
                        :data-command-id="cmd.id"
                        class="group inline-flex items-center cursor-pointer rounded-md border border-border/50 bg-header/40 hover:bg-primary/15 hover:border-primary/50 hover:text-primary text-foreground transition-all duration-150 select-none"
                        :class="{ 'bg-primary/25 border-primary text-primary font-medium': isCommandSelected(cmd.id) }"
                        :style="[
                            {
                                padding: `calc(0.2rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))`,
                                fontSize: `calc(0.78em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))`
                            },
                            getCommandCardStyle(cmd, null)
                        ]"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                        :title="getCommandTooltip(cmd)"
                    >
                        <i class="fas fa-bolt text-amber-500 text-[10px] mr-1.5 flex-shrink-0"></i>
                        <span class="truncate max-w-[220px]">{{ cmd.name || cmd.command }}</span>
                    </div>
                </div>

                <!-- 3. 标准列表模式 (List) -->
                <ul v-else class="list-none p-0 m-0">
                    <li
                        v-for="(cmd) in flatFilteredCommands"
                        :key="cmd.id"
                        :data-command-id="cmd.id"
                        class="group flex justify-between items-center mb-1 cursor-pointer rounded-md hover:bg-primary/10 transition-colors duration-150"
                        :style="[
                            { padding: `calc(0.625rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` },
                            getCommandCardStyle(cmd, null)
                        ]"
                        :class="{ 'bg-primary/20 font-medium': isCommandSelected(cmd.id) }"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                    >
                        <div class="flex flex-col overflow-hidden mr-2 flex-grow">
                            <span v-if="cmd.name"
                                  class="font-medium truncate text-foreground mb-0.5"
                                  :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.name }}</span>
                            <span v-if="cmd.command"
                                  class="truncate font-mono"
                                  :class="{ 'text-sm': !cmd.name, 'text-text-secondary': true }"
                                  :style="{ fontSize: `calc(0.75em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.command }}</span>
                        </div>
                        <div class="flex items-center flex-shrink-0 opacity-100">
                            <button @click.stop="copyCommand(cmd.command)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('commandHistory.copy', '复制')">
                                <i class="fas fa-copy" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                            </button>
                            <button @click.stop="openEditForm(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('common.edit', '编辑')">
                                <i class="fas fa-edit" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                            </button>
                            <button @click.stop="confirmDelete(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-error" :title="$t('common.delete', '删除')">
                                <i class="fas fa-times" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                            </button>
                        </div>
                    </li>
                </ul>
            </div>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单模态框 -->
    <AddEditQuickCommandForm
      v-if="isFormVisible"
      :command-to-edit="commandToEdit"
      :initial-folder-id="initialFolderIdForNew"
      @close="closeForm"
    />

    <!-- 删除指令确认（面板内遮罩，不弹全屏对话框） -->
    <QuickCommandDeleteOverlay
      :visible="!!commandToDelete"
      kind="command"
      :name="commandToDelete?.name || commandToDelete?.command || ''"
      @confirm="executeDeleteCommand"
      @close="commandToDelete = null"
    />

    <!-- 删除分组确认（同上，选「指令怎么办」） -->
    <QuickCommandDeleteOverlay
      :visible="showDeleteFolderModal"
      kind="folder"
      :name="folderToDelete?.name || ''"
      :command-count="folderToDelete ? getFolderCommandCount(folderToDelete.id) : 0"
      :busy="isDeletingFolder"
      @confirm="handleConfirmDeleteFolder"
      @close="closeDeleteFolderOverlay"
    />

    <!-- Context Menu for Quick Commands -->
    <div
      v-if="quickCommandContextMenuVisible"
      class="fixed bg-popover text-foreground border border-border/70 shadow-xl rounded-xl py-1.5 z-50 min-w-[190px] quick-command-context-menu"
      style="background-color: var(--popover-bg-color, var(--app-bg-color));"
      :style="{ top: `${quickCommandContextMenuPosition.y}px`, left: `${quickCommandContextMenuPosition.x}px` }"
      @click.stop
    >
      <div v-if="quickCommandContextTargetCommand" class="px-3 py-1 text-xs text-text-secondary border-b border-border/40 font-mono truncate max-w-[220px]">
        {{ quickCommandContextTargetCommand.name || quickCommandContextTargetCommand.command }}
      </div>
      <ul v-if="quickCommandContextTargetCommand" class="list-none p-0 m-0 mt-1">
        <!-- 1. 执行 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('execute', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-play text-xs text-primary w-4 text-center"></i>
          <span>{{ t('quickCommands.form.execute', '执行') }}</span>
        </li>

        <!-- 2. 编辑 (打开编辑模态框) -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('edit', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-edit text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
          <span>{{ t('common.edit', '编辑') }}</span>
        </li>

        <!-- 3. 复制命令 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('copy', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-copy text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
          <span>{{ t('commandHistory.copy', '复制') }}</span>
        </li>

        <!-- 4. 发送到全部会话 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('sendToAllSessions', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-paper-plane text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
          <span>{{ t('quickCommands.actions.sendToAllSessions', '发送到全部会话') }}</span>
        </li>

        <!-- 5. 移至文件夹 -->
        <li
          class="relative group px-3 py-1.5 cursor-pointer flex items-center justify-between text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @mouseenter="handleMoveSubMenuTriggerEnter"
          @mouseleave="handleMoveSubMenuTriggerLeave"
        >
          <div class="flex items-center gap-2.5">
            <i class="fas fa-folder-tree text-xs text-amber-400 w-4 text-center"></i>
            <span>{{ t('folders.moveToFolder', '移至文件夹') }}</span>
          </div>
          <i class="fas fa-chevron-right text-[10px] text-text-secondary"></i>

          <!-- 子菜单：所有文件夹列表 -->
          <div
            v-if="showMoveSubMenu"
            :class="[
              'absolute bg-popover text-foreground border border-border/70 shadow-xl rounded-xl py-1 z-50 min-w-[160px] overflow-y-auto',
              moveSubMenuPlacement.alignX === 'left'
                ? 'right-[calc(100%+4px)] after:content-[\'\'] after:absolute after:-right-2 after:top-0 after:bottom-0 after:w-2'
                : 'left-[calc(100%+4px)] before:content-[\'\'] before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2',
              moveSubMenuPlacement.alignY === 'bottom' ? 'bottom-0' : 'top-0'
            ]"
            :style="{
              backgroundColor: 'var(--popover-bg-color, var(--app-bg-color))',
              maxHeight: moveSubMenuPlacement.maxHeight
            }"
            @mouseenter="handleMoveSubMenuEnter"
            @mouseleave="handleMoveSubMenuLeave"
            @click.stop
          >
            <div
              @click="handleMoveCommandToFolder(quickCommandContextTargetCommand!, null)"
              class="px-2.5 py-1.5 text-xs text-text-secondary hover:bg-muted hover:text-foreground cursor-pointer flex items-center gap-2"
            >
              <i class="fas fa-inbox text-xs"></i>
              <span>{{ t('folders.uncategorized', '未分类') }}</span>
            </div>
            <div v-if="quickCommandFoldersStore.folders.length > 0" class="h-px bg-border/40 my-0.5"></div>
            <div
              v-for="folder in quickCommandFoldersStore.folders"
              :key="folder.id"
              @click="handleMoveCommandToFolder(quickCommandContextTargetCommand!, folder.id)"
              class="px-2.5 py-1.5 text-xs text-foreground hover:bg-muted cursor-pointer flex items-center gap-2 truncate"
            >
              <i class="fas fa-folder text-amber-400 text-xs"></i>
              <span class="truncate">{{ folder.name }}</span>
            </div>
          </div>
        </li>

        <!-- 分割线 -->
        <div class="h-px bg-border/40 my-1 mx-1"></div>

        <!-- 6. 删除 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-error hover:bg-error/10 text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('delete', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-trash-alt text-xs text-error w-4 text-center"></i>
          <span>{{ t('common.delete', '删除') }}</span>
        </li>
      </ul>
    </div>

    <!-- Context Menu for Folders -->
    <div
      v-if="folderContextMenuVisible"
      class="fixed bg-popover text-foreground border border-border/70 shadow-xl rounded-xl py-1.5 z-50 min-w-[160px] folder-context-menu"
      style="background-color: var(--popover-bg-color, var(--app-bg-color));"
      :style="{ top: `${folderContextMenuPosition.y}px`, left: `${folderContextMenuPosition.x}px` }"
      @click.stop
    >
      <div v-if="folderContextMenuTargetFolder" class="px-3 py-1 text-xs text-text-secondary border-b border-border/40 font-mono truncate max-w-[200px] flex items-center gap-1.5">
        <i
          class="fas fa-folder text-xs flex-shrink-0 transition-colors"
          :class="folderContextMenuTargetFolder.background_color ? '' : 'text-amber-400'"
          :style="folderContextMenuTargetFolder.background_color ? { color: folderContextMenuTargetFolder.background_color } : {}"
        ></i>
        <span class="truncate">{{ folderContextMenuTargetFolder.name }}</span>
      </div>
      <ul v-if="folderContextMenuTargetFolder" class="list-none p-0 m-0 mt-1">
        <!-- 1. 修改颜色 -->
        <li
          class="relative group px-3 py-1.5 cursor-pointer flex items-center justify-between text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="openFolderColorFromMenu($event, folderContextMenuTargetFolder)"
        >
          <div class="flex items-center gap-2.5">
            <i class="fas fa-palette text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
            <span>{{ t('folders.folderColor', '文件夹背景颜色') }}</span>
          </div>
          <span
            v-if="folderContextMenuTargetFolder.background_color"
            class="w-2.5 h-2.5 rounded-full ring-1 ring-white/20"
            :style="{ backgroundColor: folderContextMenuTargetFolder.background_color }"
          ></span>
        </li>

        <!-- 2. 重命名 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleFolderMenuAction('rename', folderContextMenuTargetFolder)"
        >
          <i class="fas fa-pencil-alt text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
          <span>{{ t('folders.renameFolder', '重命名文件夹') }}</span>
        </li>

        <!-- 分割线 -->
        <div class="h-px bg-border/40 my-1 mx-1"></div>

        <!-- 3. 删除 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-error hover:bg-error/10 text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleFolderMenuAction('delete', folderContextMenuTargetFolder)"
        >
          <i class="fas fa-trash-alt text-xs text-error w-4 text-center"></i>
          <span>{{ t('folders.deleteFolder', '删除文件夹') }}</span>
        </li>
      </ul>
    </div>

    <!-- 新建文件夹弹窗 -->
    <div
      v-if="isCreatingFolderModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      @click.self="isCreatingFolderModal = false"
    >
      <div class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl p-5 w-80 max-w-[90vw] animate-fadeIn" style="background-color: var(--app-bg-color);" @click.stop>
        <div class="flex items-center gap-2 mb-3">
          <div class="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center">
            <i class="fas fa-folder-plus text-sm"></i>
          </div>
          <h3 class="text-sm font-semibold text-foreground">{{ t('folders.newFolder', '新建文件夹') }}</h3>
        </div>
        <input
          v-model="newQuickCommandFolderName"
          type="text"
          :placeholder="t('folders.newFolderPlaceholder', '输入文件夹名称...')"
          class="w-full px-3 py-2 text-xs border border-border/70 rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 mb-4"
          @keydown.enter.prevent="confirmCreateQuickCommandFolder"
          @keydown.esc.prevent="isCreatingFolderModal = false"
          autofocus
        />
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            @click="isCreatingFolderModal = false"
            class="px-3 py-1.5 text-xs text-text-secondary hover:text-foreground rounded-lg border border-border/60 hover:bg-muted"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            @click="confirmCreateQuickCommandFolder"
            class="px-3 py-1.5 text-xs bg-primary text-white font-medium rounded-lg hover:bg-primary-hover shadow-xs"
          >
            {{ t('common.create', '创建') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick, defineExpose, watch, watchEffect } from 'vue';
import { storeToRefs } from 'pinia';
import { useQuickCommandsStore, type QuickCommandFE, type QuickCommandSortByType, type GroupedQuickCommands } from '../stores/quickCommands.store';
import { useQuickCommandFoldersStore } from '../stores/quickCommandFolders.store'; 
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useI18n } from 'vue-i18n';
import { copyToClipboard } from '../utils/clipboard';
import { resolveFolderColor, resolveCommandFolderColor, countCommandsInFolder } from '../utils/quickCommandDisplay';
import { useQuickCommandExecution } from '../composables/quickCommands/useQuickCommandExecution';
import { promptQuickCommandVariables } from '../composables/quickCommands/useQuickCommandVariablePrompt';
import { useQuickCommandFolderEditing } from '../composables/quickCommands/useQuickCommandFolderEditing';
import { useQuickCommandMenuActions, type QuickCommandMenuAction } from '../composables/quickCommands/useQuickCommandMenuActions';
import { useQuickCommandSearchNavigation } from '../composables/quickCommands/useQuickCommandSearchNavigation';
import AddEditQuickCommandForm from '../components/AddEditQuickCommandForm.vue';
import QuickCommandDeleteOverlay from '../components/QuickCommandDeleteOverlay.vue';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store'; 
import { useSettingsStore } from '../stores/settings.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import { useSessionStore } from '../stores/session.store';
import type { SessionState } from '../stores/session/types'; 
import { useConnectionsStore } from '../stores/connections.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useComponentStateStore } from '../stores/componentState.store';
import { useLayoutStore } from '../stores/layout.store';
import ColorPickerPopover from '../components/common/ColorPickerPopover.vue';
import { resolveEffectiveColor, getItemColoredCardStyle } from '../utils/colorUtils';

const quickCommandsStore = useQuickCommandsStore();
const quickCommandFoldersStore = useQuickCommandFoldersStore(); 
const uiNotificationsStore = useUiNotificationsStore();
const { t } = useI18n();
const focusSwitcherStore = useFocusSwitcherStore();
const settingsStore = useSettingsStore();
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const sessionStore = useSessionStore(); 
const connectionsStore = useConnectionsStore();

// 文件夹背景调色板状态
const activeFolderColorPickerId = ref<number | null>(null);
const activeFolderColorPickerTriggerEl = ref<HTMLElement | null>(null);

const toggleFolderColorPicker = (folderId: number, e: Event) => {
  e.stopPropagation();
  if (activeFolderColorPickerId.value === folderId) {
    activeFolderColorPickerId.value = null;
    activeFolderColorPickerTriggerEl.value = null;
  } else {
    activeFolderColorPickerId.value = folderId;
    activeFolderColorPickerTriggerEl.value = (e.currentTarget as HTMLElement) || (e.target as HTMLElement);
  }
};

const handleUpdateFolderColor = async (folderId: number, color: string | null) => {
  await quickCommandFoldersStore.updateFolderColor(folderId, color);
  activeFolderColorPickerId.value = null;
  activeFolderColorPickerTriggerEl.value = null;
};

const getFolderColorById = (folderId?: number | null): string | null =>
  resolveFolderColor(quickCommandFoldersStore.folders, folderId);

const getCommandFolderColor = (cmd: QuickCommandFE, groupFolderId?: number | null): string | null =>
  resolveCommandFolderColor(quickCommandFoldersStore.folders, cmd, groupFolderId);

const getCommandCardStyle = (cmd: QuickCommandFE, groupFolderId?: number | null) => {
  const folderColor = getCommandFolderColor(cmd, groupFolderId);
  const effectiveColor = resolveEffectiveColor(cmd.background_color, folderColor);
  if (!effectiveColor) return {};
  return getItemColoredCardStyle(effectiveColor, { alpha: 0.14, borderAlpha: 0.35 });
};

const props = withDefaults(
  defineProps<{
    instanceId?: string;
  }>(),
  {
    instanceId: 'default',
  }
);

const emit = defineEmits<{
  (e: 'execute-command', command: string): void;
}>();

const { isMobile: isMobileDevice } = useDeviceDetection();
const isMobile = computed(() => isMobileDevice.value || (typeof window !== 'undefined' && window.innerWidth < 768));
const platform = computed<'mobile' | 'desktop'>(() => isMobile.value ? 'mobile' : 'desktop');

const componentStateStore = useComponentStateStore();
const layoutStore = useLayoutStore();

// 独立实例与分端存储的 Key
const storageKey = computed(() => `qc_view_mode:${platform.value}:${props.instanceId || 'default'}`); 

const hoveredItemId = ref<number | null>(null);
const isFormVisible = ref(false);
const commandToEdit = ref<QuickCommandFE | null>(null);
const commandListContainerRef = ref<HTMLDivElement | null>(null); // Changed ref name to match template
const searchInputRef = ref<HTMLInputElement | null>(null); // +++ Ref for the search input +++
let unregisterFocus: (() => void) | null = null; // +++ 保存注销函数 +++

// +++ State for inline folder editing +++
const folderInputRefs = ref(new Map<string | number, HTMLInputElement | null>());

// +++ 右键菜单状态 +++
const quickCommandContextMenuVisible = ref(false);
const quickCommandContextMenuPosition = ref({ x: 0, y: 0 });
const quickCommandContextTargetCommand = ref<QuickCommandFE | null>(null);
const showMoveSubMenu = ref(false);
let moveSubMenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
const moveSubMenuPlacement = ref<{
  alignX: 'left' | 'right';
  alignY: 'top' | 'bottom';
  maxHeight?: string;
}>({ alignX: 'right', alignY: 'top', maxHeight: '192px' });

const handleMoveSubMenuTriggerEnter = (event: MouseEvent) => {
  if (moveSubMenuCloseTimer) {
    clearTimeout(moveSubMenuCloseTimer);
    moveSubMenuCloseTimer = null;
  }
  const triggerEl = event.currentTarget as HTMLElement;
  if (triggerEl) {
    const rect = triggerEl.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    const subMenuWidth = 170;
    const estimatedHeight = 210;

    // 水平方向：右侧空间不足且左侧空间更大时，向左翻转
    const spaceRight = windowWidth - rect.right;
    const spaceLeft = rect.left;
    const alignX = (spaceRight < subMenuWidth && spaceLeft > spaceRight) ? 'left' : 'right';

    // 垂直方向：下方空间不足且上方空间更大时，向上贴底翻转
    const spaceBelow = windowHeight - rect.top;
    const spaceAbove = rect.bottom;
    const alignY = (spaceBelow < estimatedHeight && spaceAbove > spaceBelow) ? 'bottom' : 'top';

    // 动态限制最大高度，防止极端窗口尺寸下溢出可视区域
    const availableSpace = alignY === 'top' ? (spaceBelow - 16) : (spaceAbove - 16);
    const calculatedMaxHeight = Math.max(120, Math.min(220, Math.floor(availableSpace)));

    moveSubMenuPlacement.value = {
      alignX,
      alignY,
      maxHeight: `${calculatedMaxHeight}px`
    };
  }
  showMoveSubMenu.value = true;
};

const handleMoveSubMenuTriggerLeave = () => {
  if (moveSubMenuCloseTimer) {
    clearTimeout(moveSubMenuCloseTimer);
  }
  moveSubMenuCloseTimer = setTimeout(() => {
    showMoveSubMenu.value = false;
    moveSubMenuCloseTimer = null;
  }, 180);
};

const handleMoveSubMenuEnter = () => {
  if (moveSubMenuCloseTimer) {
    clearTimeout(moveSubMenuCloseTimer);
    moveSubMenuCloseTimer = null;
  }
  showMoveSubMenu.value = true;
};

const handleMoveSubMenuLeave = () => {
  if (moveSubMenuCloseTimer) {
    clearTimeout(moveSubMenuCloseTimer);
  }
  moveSubMenuCloseTimer = setTimeout(() => {
    showMoveSubMenu.value = false;
    moveSubMenuCloseTimer = null;
  }, 180);
};

// +++ 文件夹弹窗状态 +++


// --- 从 Store 获取状态和 Getter ---
const searchTerm = computed(() => quickCommandsStore.searchTerm);
const sortBy = computed(() => quickCommandsStore.sortBy);
// Use the new grouped getter
const filteredAndGroupedCommands = computed(() => quickCommandsStore.filteredAndGroupedCommands);
const isLoading = computed(() => quickCommandsStore.isLoading);


const { selectedIndex: storeSelectedIndex, flatVisibleCommands, expandedGroups } = storeToRefs(quickCommandsStore);

// --- 搜索 / 键盘导航 / 分组折叠（实现见 composables/quickCommands/useQuickCommandSearchNavigation.ts）---
const {
  localSearchTerm,
  updateSearchTerm,
  handleSearchInputKeydown,
  toggleGroup,
  scrollToSelected,
} = useQuickCommandSearchNavigation({
  flatVisibleCommands,
  selectedIndex: storeSelectedIndex,
  listContainerRef: commandListContainerRef,
  onEnter: (cmd) => executeCommand(cmd),
});

// --- 文件夹改名 / 新建（实现见 composables/quickCommands/useQuickCommandFolderEditing.ts）---
const {
  editingFolderId,
  editedFolderName,
  startEditingFolder,
  cancelEditingFolder,
  finishEditingFolder,
  isCreatingFolderModal,
  newQuickCommandFolderName,
  showDeleteFolderModal,
  folderToDelete,
  isDeletingFolder,
  confirmCreateFolder,
  handleDeleteFolder,
  confirmDeleteFolder,
} = useQuickCommandFolderEditing({
  groupedCommands: filteredAndGroupedCommands,
  expandedGroups,
  // 桌面侧栏：新建后切过去；删掉当前选中项时回退到全部
  onFolderCreated: (folderId) => {
    if (folderLayoutMode.value === 'sidebar') {
      sidebarActiveFolderId.value = folderId;
    }
  },
  onFolderDeleted: (folderId) => {
    if (sidebarActiveFolderId.value === folderId) {
      sidebarActiveFolderId.value = 'all';
    }
  },
});

// 模板沿用旧名字，避免大面积改模板
const confirmCreateQuickCommandFolder = confirmCreateFolder;
const handleConfirmDeleteFolder = confirmDeleteFolder;
// 面板内遮罩的取消：删除进行中不允许关掉（避免「已删了但遮罩还留着」）
const closeDeleteFolderOverlay = () => {
  if (isDeletingFolder.value) return;
  showDeleteFolderModal.value = false;
  folderToDelete.value = null;
};
const {
  showQuickCommandFoldersBoolean,
  quickCommandRowSizeMultiplierNumber: qcRowSizeMultiplierFromStore,
  quickCommandsCompactModeBoolean, // +++ 引入紧凑模式状态 +++
} = storeToRefs(settingsStore);

const quickCommandRowSizeMultiplier = ref(1.0);

watchEffect(() => {
  const storeVal = qcRowSizeMultiplierFromStore.value;
  if (storeVal && typeof storeVal === 'number' && storeVal > 0) {
    if (quickCommandRowSizeMultiplier.value !== storeVal) {
      quickCommandRowSizeMultiplier.value = storeVal;
      // console.log(`[QuickCmdView] Row size multiplier loaded from store: ${storeVal}`);
    }
  } else {
    // console.log(`[QuickCmdView] No valid row size multiplier in store for QuickCommands, using default: ${quickCommandRowSizeMultiplier.value}`);
  }
});

const handleWheel = (event: WheelEvent) => {
    // event.ctrlKey 和 event.preventDefault() 将由模板中的 .ctrl.prevent 修饰符处理
    const delta = event.deltaY > 0 ? -0.05 : 0.05;
    const newMultiplier = Math.max(0.5, Math.min(2.5, quickCommandRowSizeMultiplier.value + delta));
    const oldMultiplier = quickCommandRowSizeMultiplier.value;
    quickCommandRowSizeMultiplier.value = parseFloat(newMultiplier.toFixed(2));

    if (quickCommandRowSizeMultiplier.value !== oldMultiplier) {
      // console.log(`[QuickCmdView] Row size multiplier changed: ${quickCommandRowSizeMultiplier.value}. Saving to store...`);
      // 假设 settingsStore 有一个名为 updateQuickCommandRowSizeMultiplier 的 action
      if (settingsStore.updateQuickCommandRowSizeMultiplier) {
        settingsStore.updateQuickCommandRowSizeMultiplier(quickCommandRowSizeMultiplier.value);
      } else {
        console.warn('[QuickCmdView] settingsStore.updateQuickCommandRowSizeMultiplier action not found.');
      }
    }
};

// 计算属性，仅过滤和排序，不分组
const flatFilteredCommands = computed(() => {
    // 直接使用 store 中的 flatVisibleCommands，因为它已经处理了过滤和排序
    return quickCommandsStore.flatVisibleCommands;
});

// --- 三视图模式定义与持久化 (组件实例隔离 + 移动/桌面分端 + 后端持久化) ---
export type QuickCommandsViewMode = 'grid' | 'list' | 'pills';

const getDefaultViewMode = (): QuickCommandsViewMode => {
  if (quickCommandsCompactModeBoolean.value) {
    return 'pills';
  }
  return 'grid'; // 默认推荐使用高空间利用率的网格卡片
};

const currentViewMode = ref<QuickCommandsViewMode>(
  componentStateStore.getState<QuickCommandsViewMode>(storageKey.value, getDefaultViewMode())
);

// 监听 storageKey 变动（如分端切换或实例切换）自动同步
watch(storageKey, (newKey) => {
  const saved = componentStateStore.getState<QuickCommandsViewMode>(newKey, getDefaultViewMode());
  if (saved && ['grid', 'list', 'pills'].includes(saved)) {
    currentViewMode.value = saved;
  }
});

// 后端异步拉取完成 / 被其它设备同步改动时，更新至最新持久化设置
watch(() => [componentStateStore.isLoaded, componentStateStore.revision], () => {
  const saved = componentStateStore.getState<QuickCommandsViewMode>(storageKey.value, currentViewMode.value);
  if (saved && ['grid', 'list', 'pills'].includes(saved)) {
    currentViewMode.value = saved;
  }
});

const isCompactMode = computed(() => currentViewMode.value === 'pills');

const cycleViewMode = () => {
  const modes: QuickCommandsViewMode[] = ['grid', 'list', 'pills'];
  const nextIndex = (modes.indexOf(currentViewMode.value) + 1) % modes.length;
  const nextMode = modes[nextIndex];
  currentViewMode.value = nextMode;
  componentStateStore.setState(storageKey.value, nextMode);
};

const viewModeIcon = computed(() => {
  switch (currentViewMode.value) {
    case 'grid': return 'fa-table-cells-large';
    case 'list': return 'fa-list';
    // 原先是 FontAwesome **Pro** 的 folders 图标，免费包里没有 → 按钮是空的。改用 capsules（真·药丸）
    case 'pills': return 'fa-capsules';
    default: return 'fa-table-cells-large';
  }
});

const viewModeTitle = computed(() => {
  const modeKey = currentViewMode.value;
  const modeName = t(`quickCommands.viewMode.${modeKey}`, modeKey);
  return t('quickCommands.viewMode.toggle', { mode: modeName }, `切换视图 (当前: ${modeName})`);
});

// --- 文件夹布局模式定义与持久化 (折叠树 Accordion vs 侧栏 Sidebar) ---
export type FolderLayoutMode = 'accordion' | 'sidebar';

const storageFolderLayoutKey = computed(() => `qc_folder_layout:${platform.value}:${props.instanceId || 'default'}`);

const getInitialFolderLayoutMode = (): FolderLayoutMode => {
  const saved = componentStateStore.getState<FolderLayoutMode>(storageFolderLayoutKey.value, 'accordion');
  if (saved && (saved === 'accordion' || saved === 'sidebar')) {
    return saved;
  }
  try {
    const local = localStorage.getItem('nexus:qc_folder_layout_mode');
    if (local === 'accordion' || local === 'sidebar') {
      return local as FolderLayoutMode;
    }
  } catch (_) {}
  return 'accordion';
};

const folderLayoutMode = ref<FolderLayoutMode>(getInitialFolderLayoutMode());

// 监听 storageFolderLayoutKey 变动同步
watch(storageFolderLayoutKey, (newKey) => {
  const saved = componentStateStore.getState<FolderLayoutMode>(newKey, getInitialFolderLayoutMode());
  if (saved && ['accordion', 'sidebar'].includes(saved)) {
    folderLayoutMode.value = saved;
  }
});

// 后端异步拉取完成 / 被其它设备同步改动时，跟进文件夹布局
watch(() => [componentStateStore.isLoaded, componentStateStore.revision], () => {
  const saved = componentStateStore.getState<FolderLayoutMode>(storageFolderLayoutKey.value, folderLayoutMode.value);
  if (saved && (saved === 'accordion' || saved === 'sidebar')) {
    folderLayoutMode.value = saved;
  }
});

// 监听状态变动持久化
watch(folderLayoutMode, (newMode) => {
  // 值来自「同步重载」时不要回写：否则 重载 → 回写 → 新 HLC → 对端又拉取 → 再回写，
  // 两台设备会互相把同一个值来回推，永远不收敛。
  const stored = componentStateStore.getState<FolderLayoutMode>(storageFolderLayoutKey.value);
  if (stored === newMode) return;
  componentStateStore.setState(storageFolderLayoutKey.value, newMode);
  try {
    localStorage.setItem('nexus:qc_folder_layout_mode', newMode);
  } catch (_) {}
});

const toggleFolderLayoutMode = () => {
  folderLayoutMode.value = folderLayoutMode.value === 'sidebar' ? 'accordion' : 'sidebar';
};

const folderLayoutTitle = computed(() => {
  return folderLayoutMode.value === 'sidebar'
    ? t('quickCommands.folderLayout.switchToAccordion', '切换为折叠树视图')
    : t('quickCommands.folderLayout.switchToSidebar', '切换为侧栏文件夹视图');
});

// --- 侧栏文件夹导航状态与指令过滤 ---
const sidebarActiveFolderId = ref<number | 'all' | 'untagged'>('all');

const getFolderCommandCount = (folderId: number | 'all' | 'untagged'): number =>
  countCommandsInFolder(quickCommandsStore.quickCommandsList, folderId);

const activeSidebarFolderName = computed(() => {
  if (sidebarActiveFolderId.value === 'all') {
    return t('quickCommands.allCommands', '全部指令');
  }
  if (sidebarActiveFolderId.value === 'untagged') {
    return t('quickCommands.untagged', '未分类');
  }
  const folder = quickCommandFoldersStore.folders.find(f => f.id === sidebarActiveFolderId.value);
  return folder?.name || '';
});

const activeSidebarFolderColor = computed(() => {
  if (typeof sidebarActiveFolderId.value === 'number') {
    return getFolderColorById(sidebarActiveFolderId.value);
  }
  return null;
});

const sidebarDisplayCommands = computed(() => {
  const allList = quickCommandsStore.quickCommandsList;
  let baseList: QuickCommandFE[];
  if (sidebarActiveFolderId.value === 'all') {
    baseList = allList;
  } else if (sidebarActiveFolderId.value === 'untagged') {
    baseList = allList.filter(cmd => !cmd.folderIds || cmd.folderIds.length === 0);
  } else {
    const fid = sidebarActiveFolderId.value as number;
    baseList = allList.filter(cmd => cmd.folderIds && cmd.folderIds.includes(fid));
  }

  const term = searchTerm.value.trim().toLowerCase();
  if (term) {
    baseList = baseList.filter(cmd => {
      const matchName = cmd.name && cmd.name.toLowerCase().includes(term);
      const matchCommand = cmd.command && cmd.command.toLowerCase().includes(term);
      return matchName || matchCommand;
    });
  }

  const sorted = [...baseList];
  sorted.sort((a, b) => {
    if (sortBy.value === 'usage_count') {
      if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
    } else if (sortBy.value === 'last_used') {
      if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
    }
    const nameA = a.name ?? a.command;
    const nameB = b.name ?? b.command;
    return nameA.localeCompare(nameB);
  });

  return sorted;
});

// --- Helper function for selection check ---
const isCommandSelected = (commandId: number): boolean => {
    // 使用 store 的 flatVisibleCommands 和 storeSelectedIndex
    if (storeSelectedIndex.value < 0 || !flatVisibleCommands.value[storeSelectedIndex.value]) {
        return false;
    }
    return flatVisibleCommands.value[storeSelectedIndex.value].id === commandId;
};

// 安全获取指令 Tooltip 描述
const getCommandTooltip = (cmd: QuickCommandFE): string => {
  if (cmd.command) {
    return cmd.name ? `${cmd.name}: ${cmd.command}` : cmd.command;
  }
  return cmd.name || '';
};

// --- 侧栏宽度可拖拽调整与本地持久化 ---
const DEFAULT_SIDEBAR_WIDTH = 200;
const MIN_SIDEBAR_WIDTH = 140;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = 'nexus:qc_sidebar_width';

const getInitialSidebarWidth = (): number => {
  try {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= MIN_SIDEBAR_WIDTH && parsed <= MAX_SIDEBAR_WIDTH) {
        return parsed;
      }
    }
  } catch (_) {}
  return DEFAULT_SIDEBAR_WIDTH;
};

const sidebarWidth = ref<number>(getInitialSidebarWidth());
const isDraggingSidebar = ref(false);

const startResizeSidebar = (e: MouseEvent) => {
  e.preventDefault();
  isDraggingSidebar.value = true;
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  const prevCursor = document.body.style.cursor;
  const prevUserSelect = document.body.style.userSelect;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMouseMove = (moveEvent: MouseEvent) => {
    const deltaX = moveEvent.clientX - startX;
    const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + deltaX));
    sidebarWidth.value = newWidth;
  };

  const onMouseUp = () => {
    isDraggingSidebar.value = false;
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevUserSelect;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, sidebarWidth.value.toString());
    } catch (_) {}
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
};

// --- 窄侧栏判定与防按钮文本重叠优化 ---
const NARROW_SIDEBAR_THRESHOLD = 180;
const isNarrowSidebar = computed(() => sidebarWidth.value < NARROW_SIDEBAR_THRESHOLD);

// --- 侧栏文件夹右键上下文菜单 ---
const folderContextMenuVisible = ref(false);
const folderContextMenuPosition = ref({ x: 0, y: 0 });
const folderContextMenuTargetFolder = ref<any>(null);

const showFolderContextMenu = (event: MouseEvent, folder: any) => {
  event.preventDefault();
  folderContextMenuTargetFolder.value = folder;
  folderContextMenuPosition.value = { x: event.clientX, y: event.clientY };
  folderContextMenuVisible.value = true;
  document.addEventListener('click', closeFolderContextMenu, { once: true });

  nextTick(() => {
    const menuEl = document.querySelector('.folder-context-menu') as HTMLElement;
    if (menuEl) {
      const rect = menuEl.getBoundingClientRect();
      let fx = folderContextMenuPosition.value.x;
      let fy = folderContextMenuPosition.value.y;
      if (fx + rect.width > window.innerWidth) fx = window.innerWidth - rect.width - 8;
      if (fy + rect.height > window.innerHeight) fy = window.innerHeight - rect.height - 8;
      folderContextMenuPosition.value = { x: Math.max(8, fx), y: Math.max(8, fy) };
    }
  });
};

const closeFolderContextMenu = () => {
  folderContextMenuVisible.value = false;
  folderContextMenuTargetFolder.value = null;
  document.removeEventListener('click', closeFolderContextMenu);
};

const handleFolderMenuAction = (action: 'rename' | 'delete', folder: any) => {
  closeFolderContextMenu();
  if (action === 'rename') {
    startEditingFolder(folder.id, folder.name);
  } else if (action === 'delete') {
    handleDeleteFolder(folder.id, folder.name);
  }
};

const openFolderColorFromMenu = (event: MouseEvent, folder: any) => {
  closeFolderContextMenu();
  toggleFolderColorPicker(folder.id, event);
};



// --- 生命周期钩子 ---
onMounted(async () => { // Make onMounted async
    // 初始化组件实例后端状态仓库
    componentStateStore.initialize();
    // Load expanded groups state first
    quickCommandsStore.loadExpandedGroups();
    // Then fetch commands (which might initialize expandedGroups for new groups)
    await quickCommandsStore.fetchQuickCommands();
    // Also fetch the quick command folders using the correct store instance
    await quickCommandFoldersStore.fetchFolders();
    // +++ 注册自定义聚焦动作 +++
    unregisterFocus = focusSwitcherStore.registerFocusAction('quickCommandsSearch', focusSearchInput);
});

onBeforeUnmount(() => {
  // 当检测不到该组件存在于布局中时，移除该存储项（独立实例垃圾回收）
  const instance = props.instanceId;
  const permanentList = ['modal', 'default', 'sidebar-left', 'sidebar-right'];
  if (instance && !permanentList.includes(instance)) {
    try {
      const activeIds = layoutStore.getAllActivePaneIds ? layoutStore.getAllActivePaneIds() : new Set<string>();
      if (!activeIds.has(instance)) {
        void componentStateStore.removeState(`qc_view_mode:desktop:${instance}`);
        void componentStateStore.removeState(`qc_view_mode:mobile:${instance}`);
      }
    } catch (e) {
      console.warn('[QuickCommandsView] 卸载时清理组件状态失败:', e);
    }
  }
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (moveSubMenuCloseTimer) {
    clearTimeout(moveSubMenuCloseTimer);
    moveSubMenuCloseTimer = null;
  }
  document.removeEventListener('click', closeQuickCommandContextMenu);
  document.removeEventListener('click', closeFolderContextMenu);
  // +++ 调用保存的注销函数 +++
  if (unregisterFocus) {
    unregisterFocus();
  }
});


// +++ Watcher to focus input when editing starts +++
watch(editingFolderId, async (newId) => {
    if (newId !== null) {
        await nextTick();
        const inputRef = folderInputRefs.value.get(newId);
        if (inputRef) {
            inputRef.focus();
            inputRef.select();
        } else {
             console.error(`[QuickCmdView] Watcher: Input ref for ID ${newId} not found.`);
        }
    }
});

// 监听显示模式变化，重置选择
watch(showQuickCommandFoldersBoolean, () => {
    quickCommandsStore.resetSelection();
});


// --- 事件处理 ---

// 更新搜索词 (带 120ms 防抖，消除连续打字掉帧)


// +++ 重构滚动逻辑 +++


// Watch for changes in the store's selectedIndex and scroll
watch(storeSelectedIndex, (newIndex) => {
  scrollToSelected(newIndex);
});

// Keyboard navigation now operates on the flat visible list from the store


// 处理搜索框失焦事件
const handleSearchInputBlur = () => {
  // 延迟执行，以允许点击列表项事件先触发
  setTimeout(() => {
    // 检查焦点是否还在组件内部的其他可聚焦元素上（例如按钮）
    // 如果焦点移出整个组件区域，则重置选择
    if (document.activeElement !== searchInputRef.value && !commandListContainerRef.value?.contains(document.activeElement)) {
        quickCommandsStore.resetSelection();
    }
}, 100); // 短暂延迟
};

// 切换排序方式 (Action remains the same, store handles the logic change)
const toggleSortBy = () => {
    const newSortBy = sortBy.value === 'name' ? 'last_used' : 'name';
    quickCommandsStore.setSortBy(newSortBy);
};

// +++ Action to toggle group expansion +++


// 计算排序按钮的 title 和 icon
const sortButtonTitle = computed(() => {
  return sortBy.value === 'name'
    ? t('quickCommands.sortByName', '按名称排序')
    : t('quickCommands.sortByLastUsed', '按最近使用排序');
});

const sortButtonIcon = computed(() => {
  // 使用 Font Awesome 图标示例
  return sortBy.value === 'name' ? 'fas fa-sort-alpha-down' : 'fas fa-clock';
});


const initialFolderIdForNew = ref<number | null>(null);

const openAddForm = (folderId?: number | null | Event) => {
  commandToEdit.value = null;
  initialFolderIdForNew.value = typeof folderId === 'number' ? folderId : null;
  isFormVisible.value = true;
};

const openEditForm = (command: QuickCommandFE) => {
  initialFolderIdForNew.value = null;
  commandToEdit.value = command;
  isFormVisible.value = true;
};

const closeForm = () => {
  isFormVisible.value = false;
  commandToEdit.value = null;
  initialFolderIdForNew.value = null;
};

// 删除指令：先亮面板内遮罩，确认后才真正调接口（不再弹全屏确认对话框）
const commandToDelete = ref<QuickCommandFE | null>(null);
const confirmDelete = (command: QuickCommandFE) => {
  commandToDelete.value = command;
};

const executeDeleteCommand = async () => {
  const command = commandToDelete.value;
  if (!command) return;
  try {
    await quickCommandsStore.deleteQuickCommand(command.id);
  } finally {
    commandToDelete.value = null;
  }
};

// 复制命令到剪贴板
const copyCommand = async (command: string) => {
  // 统一走 utils/clipboard：它带 iOS readonly 兜底（手写版本会弹出软键盘）
  if (await copyToClipboard(command)) {
    uiNotificationsStore.showSuccess(t('commandHistory.copied', '已复制到剪贴板'));
  } else {
    uiNotificationsStore.showError(t('commandHistory.copyFailed', '复制失败'));
  }
};

// 执行命令
const { executeCommand } = useQuickCommandExecution({
  incrementUsage: (id) => quickCommandsStore.incrementUsage(id),
  getActiveSessionId: () => sessionStore.activeSessionId,
  emitProcessed: (payload) => emitWorkspaceEvent('quickCommand:executeProcessed', payload),
  noActiveSessionMessage: () => t('quickCommands.form.errorNoActiveSession', '没有活动的SSH会话可执行指令。'),
  onNoActiveSession: () => uiNotificationsStore.showError(t('quickCommands.form.errorNoActiveSession', '没有活动的SSH会话可执行指令。')),
  onExecuted: (processed) => emit('execute-command', processed),
  promptVariables: promptQuickCommandVariables,
});

// +++ 聚焦搜索框的方法 +++
const focusSearchInput = (): boolean => {
  if (searchInputRef.value) {
    searchInputRef.value.focus();
    return true;
  }
  return false;
};
defineExpose({ focusSearchInput });

// +++ Methods for inline folder editing +++
const setFolderInputRef = (el: any, id: string | number) => {
  if (el) {
    folderInputRefs.value.set(id, el as HTMLInputElement);
  } else {
    folderInputRefs.value.delete(id);
  }
};







// --- 长按检测 (Touch Long Press) 与右键菜单统一控制 ---
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartX = 0;
let touchStartY = 0;
const isLongPressActive = ref(false);

const openContextMenuAt = (x: number, y: number, command: QuickCommandFE) => {
  quickCommandContextTargetCommand.value = command;
  quickCommandContextMenuPosition.value = { x, y };
  quickCommandContextMenuVisible.value = true;
  document.addEventListener('click', closeQuickCommandContextMenu, { once: true });

  // 使用 nextTick 获取菜单尺寸并调整位置以防止超出屏幕
  nextTick(() => {
    const menuElement = document.querySelector('.quick-command-context-menu') as HTMLElement;
    if (menuElement) {
      const menuRect = menuElement.getBoundingClientRect();
      let finalX = quickCommandContextMenuPosition.value.x;
      let finalY = quickCommandContextMenuPosition.value.y;
      const menuWidth = menuRect.width;
      const menuHeight = menuRect.height;

      // 调整水平位置
      if (finalX + menuWidth > window.innerWidth) {
        finalX = window.innerWidth - menuWidth - 8;
      }

      // 调整垂直位置
      if (finalY + menuHeight > window.innerHeight) {
        finalY = window.innerHeight - menuHeight - 8;
      }

      // 确保菜单不超出屏幕左上角
      finalX = Math.max(8, finalX);
      finalY = Math.max(8, finalY);

      quickCommandContextMenuPosition.value = { x: finalX, y: finalY };
    }
  });
};

// 拦截长按触发后的误触点击
const handleCommandItemClick = (cmd: QuickCommandFE) => {
  executeCommand(cmd);
};

// 右键点击处理
const showQuickCommandContextMenu = (event: MouseEvent, command: QuickCommandFE) => {
  event.preventDefault();
  openContextMenuAt(event.clientX, event.clientY, command);
};

const closeQuickCommandContextMenu = () => {
  quickCommandContextMenuVisible.value = false;
  quickCommandContextTargetCommand.value = null;
  showMoveSubMenu.value = false;
  if (moveSubMenuCloseTimer) {
    clearTimeout(moveSubMenuCloseTimer);
    moveSubMenuCloseTimer = null;
  }
  document.removeEventListener('click', closeQuickCommandContextMenu);
};

// 右键/长按菜单动作处理

// --- 右键菜单动作分发（实现见 composables/quickCommands/useQuickCommandMenuActions.ts）---
const { handleQuickCommandMenuAction } = useQuickCommandMenuActions({
  closeContextMenu: closeQuickCommandContextMenu,
  executeCommand,
  openEditForm,
  copyCommand,
  confirmDelete,
});

// --- 文件夹管理操作 ---
const openCreateFolderDialog = () => {
  newQuickCommandFolderName.value = '';
  isCreatingFolderModal.value = true;
};








const handleMoveCommandToFolder = async (command: QuickCommandFE, folderId: number | null) => {
  try {
    const success = await quickCommandsStore.moveCommandToFolder(command.id, folderId);
    if (success) {
      uiNotificationsStore.showSuccess(t('folders.movedSuccess', '已成功移动到文件夹'));
      showMoveSubMenu.value = false;
      closeQuickCommandContextMenu();
    }
  } catch (error: any) {
    uiNotificationsStore.showError(error?.message || t('common.unexpectedError'));
  }
};
</script>

<style scoped>
/* 自适应网格卡片容器 (纯布局响应式，色彩全面继承主题类) */
.qc-grid-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(calc(170px * var(--qc-row-size-multiplier, 1)), 1fr));
  gap: calc(0.45rem * var(--qc-row-size-multiplier, 1));
}

/* 药丸胶囊流容器 (纯布局响应式) */
.qc-pill-container {
  display: flex;
  flex-wrap: wrap;
  gap: calc(0.35rem * var(--qc-row-size-multiplier, 1));
}
</style>
