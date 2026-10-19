 <template>
  <div class="flex flex-col h-full overflow-hidden bg-background">
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
      <!-- List Area -->
      <div class="flex-grow overflow-y-auto p-2">
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
        <div v-else-if="!isLoading && ((showQuickCommandTagsBoolean && filteredAndGroupedCommands.length === 0) || (!showQuickCommandTagsBoolean && flatFilteredCommands.length === 0)) && searchTerm" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
            <i class="fas fa-search text-xl mb-2"></i>
            <p>{{ t('quickCommands.noResults', '没有找到匹配的指令') }} "{{ searchTerm }}"</p>
        </div>

       <!-- Command List (Grouped or Flat) -->
       <div
        v-else
        class="list-none p-0 m-0 outline-none"
        ref="commandListContainerRef"
        tabindex="0"
        
        :style="{ '--qc-row-size-multiplier': quickCommandRowSizeMultiplier }"
        @keydown="handleSearchInputKeydown"
       >
            <!-- Grouped View -->
            <div v-if="showQuickCommandTagsBoolean">
                <div v-for="groupData in filteredAndGroupedCommands" :key="groupData.groupName" class="mb-1 last:mb-0">
                    <div
                        class="group font-semibold flex items-center justify-between text-foreground rounded-lg hover:bg-header/80 transition-colors duration-150 h-9 min-h-[36px] max-h-[36px] box-border"
                        :style="{ padding: isCompactMode ? `0 calc(0.6rem * var(--qc-row-size-multiplier))` : `0 calc(0.7rem * var(--qc-row-size-multiplier))` }"
                        :class="{ 'cursor-pointer': editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId) }"
                        @click="editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId) ? toggleGroup(groupData.groupName) : null"
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
                                    groupData.tagId === null
                                        ? 'fa-inbox text-text-secondary'
                                        : (expandedGroups[groupData.groupName] ? 'fa-folder-open' : 'fa-folder'),
                                    (!getFolderColorById(groupData.tagId) && groupData.tagId !== null) ? 'text-amber-400' : ''
                                ]"
                                :style="{
                                    color: getFolderColorById(groupData.tagId) || undefined,
                                    fontSize: `calc(0.9em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))`
                                }"
                            ></i>

                            <!-- Editing State -->
                            <input
                                v-if="editingTagId === (groupData.tagId === null ? 'untagged' : groupData.tagId)"
                                :key="groupData.tagId === null ? 'untagged-input' : `tag-input-${groupData.tagId}`"
                                :ref="(el) => setTagInputRef(el, groupData.tagId === null ? 'untagged' : groupData.tagId)"
                                type="text"
                                v-model="editedTagName"
                                class="bg-input border border-primary rounded px-1.5 py-0.5 w-full text-xs text-foreground focus:outline-none"
                                @blur="finishEditingTag"
                                @keydown.enter.prevent="finishEditingTag"
                                @keydown.esc.prevent="cancelEditingTag"
                                @click.stop
                            />
                            <!-- Display State -->
                            <div v-else class="flex items-center gap-2 truncate min-w-0">
                                <span
                                    class="inline-block overflow-hidden text-ellipsis whitespace-nowrap text-xs"
                                    :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"
                                >
                                    {{ groupData.groupName }}
                                </span>
                                <span class="text-[11px] text-text-secondary font-normal flex-shrink-0">({{ groupData.commands.length }})</span>
                            </div>
                        </div>

                        <!-- Actions for Folder (常驻占位防抖动，仅透明度过渡) -->
                        <div
                            v-if="groupData.tagId !== null && editingTagId !== groupData.tagId"
                            class="flex items-center gap-0.5 flex-shrink-0 h-6 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none group-hover:pointer-events-auto"
                            @click.stop
                        >
                            <!-- Folder Color Picker -->
                            <div v-if="groupData.tagId !== null" class="relative inline-flex items-center" @click.stop>
                                <button
                                    @click.stop="toggleFolderColorPicker(groupData.tagId, $event)"
                                    class="w-6 h-6 p-0 rounded text-text-secondary hover:text-foreground hover:bg-muted text-xs transition-colors flex items-center justify-center cursor-pointer"
                                    :title="t('folders.folderColor', '文件夹背景颜色')"
                                >
                                    <i class="fas fa-palette text-[10px]"></i>
                                </button>
                                <ColorPickerPopover
                                    :visible="activeFolderColorPickerId === groupData.tagId"
                                    :trigger-el="activeFolderColorPickerTriggerEl"
                                    :model-value="getFolderColorById(groupData.tagId)"
                                    @update:model-value="handleUpdateFolderColor(groupData.tagId, $event)"
                                    @close="activeFolderColorPickerId = null; activeFolderColorPickerTriggerEl = null"
                                />
                            </div>
                            <button
                                v-if="groupData.tagId !== null"
                                @click="startEditingTag(groupData.tagId, groupData.groupName)"
                                class="w-6 h-6 p-0 rounded text-text-secondary hover:text-foreground hover:bg-muted text-xs transition-colors flex items-center justify-center cursor-pointer"
                                :title="t('folders.renameFolder', '重命名文件夹')"
                            >
                                <i class="fas fa-pencil-alt text-[10px]"></i>
                            </button>
                            <button
                                v-if="groupData.tagId !== null"
                                @click="handleDeleteFolder(groupData.tagId, groupData.groupName, $event)"
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
                                class="group qc-touch-item active:scale-[0.98] flex items-center justify-between cursor-pointer rounded-lg border border-border/50 bg-header/40 hover:bg-primary/10 hover:border-primary/50 transition-all duration-150 select-none overflow-hidden"
                                :class="{ 'bg-primary/20 border-primary font-medium': isCommandSelected(cmd.id) }"
                                :style="[
                                    { padding: `calc(0.4rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))` },
                                    getCommandCardStyle(cmd, groupData.tagId)
                                ]"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                @touchstart="handleItemTouchStart($event, cmd)"
                                @touchmove="handleItemTouchMove"
                                @touchend="handleItemTouchEnd"
                                @touchcancel="handleItemTouchEnd"
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
                                class="group qc-touch-item active:scale-[0.98] inline-flex items-center cursor-pointer rounded-md border border-border/50 bg-header/40 hover:bg-primary/15 hover:border-primary/50 hover:text-primary text-foreground transition-all duration-150 select-none"
                                :class="{ 'bg-primary/25 border-primary text-primary font-medium': isCommandSelected(cmd.id) }"
                                :style="[
                                    {
                                        padding: `calc(0.2rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))`,
                                        fontSize: `calc(0.78em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))`
                                    },
                                    getCommandCardStyle(cmd, groupData.tagId)
                                ]"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                @touchstart="handleItemTouchStart($event, cmd)"
                                @touchmove="handleItemTouchMove"
                                @touchend="handleItemTouchEnd"
                                @touchcancel="handleItemTouchEnd"
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
                                class="group qc-touch-item active:scale-[0.98] flex justify-between items-center mb-1 cursor-pointer rounded-md hover:bg-primary/10 transition-all duration-150"
                                :style="[
                                    { padding: `calc(0.625rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` },
                                    getCommandCardStyle(cmd, groupData.tagId)
                                ]"
                                :class="{ 'bg-primary/20 font-medium': isCommandSelected(cmd.id) }"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                @touchstart="handleItemTouchStart($event, cmd)"
                                @touchmove="handleItemTouchMove"
                                @touchend="handleItemTouchEnd"
                                @touchcancel="handleItemTouchEnd"
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
                        class="group qc-touch-item active:scale-[0.98] flex items-center justify-between cursor-pointer rounded-lg border border-border/50 bg-header/40 hover:bg-primary/10 hover:border-primary/50 transition-all duration-150 select-none overflow-hidden"
                        :class="{ 'bg-primary/20 border-primary font-medium': isCommandSelected(cmd.id) }"
                        :style="[
                            { padding: `calc(0.4rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))` },
                            getCommandCardStyle(cmd, null)
                        ]"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                        @touchstart="handleItemTouchStart($event, cmd)"
                        @touchmove="handleItemTouchMove"
                        @touchend="handleItemTouchEnd"
                        @touchcancel="handleItemTouchEnd"
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
                        class="group qc-touch-item active:scale-[0.98] inline-flex items-center cursor-pointer rounded-md border border-border/50 bg-header/40 hover:bg-primary/15 hover:border-primary/50 hover:text-primary text-foreground transition-all duration-150 select-none"
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
                        @touchstart="handleItemTouchStart($event, cmd)"
                        @touchmove="handleItemTouchMove"
                        @touchend="handleItemTouchEnd"
                        @touchcancel="handleItemTouchEnd"
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
                        class="group qc-touch-item active:scale-[0.98] flex justify-between items-center mb-1 cursor-pointer rounded-md hover:bg-primary/10 transition-all duration-150"
                        :style="[
                            { padding: `calc(0.625rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` },
                            getCommandCardStyle(cmd, null)
                        ]"
                        :class="{ 'bg-primary/20 font-medium': isCommandSelected(cmd.id) }"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                        @touchstart="handleItemTouchStart($event, cmd)"
                        @touchmove="handleItemTouchMove"
                        @touchend="handleItemTouchEnd"
                        @touchcancel="handleItemTouchEnd"
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
      @close="closeForm"
    />

    <!-- 删除分组确认模态框 -->
    <DeleteQuickCommandFolderModal
      :visible="showDeleteFolderModal"
      :folder-name="folderToDelete?.name || ''"
      :command-count="folderToDelete ? getFolderCommandCount(folderToDelete.id) : 0"
      :is-loading="isDeletingFolder"
      @confirm="handleConfirmDeleteFolder"
      @close="showDeleteFolderModal = false; folderToDelete = null"
    />

    <!-- 移动端专属快捷指令动作抽屉 (Bottom Action Sheet) -->
    <MobileBottomSheet
      :visible="isActionSheetVisible && !!activeActionCommand"
      height="h-auto"
      max-height="max-h-[85dvh]"
      :z-index="60"
      :show-close-button="false"
      @close="closeCommandActionSheet"
    >
      <!-- 顶部指令卡片概览 -->
      <template #sub-header>
        <div v-if="activeActionCommand" class="px-4 py-3 border-b border-border/40 bg-header/20 flex items-center gap-3">
          <!-- 图标徽章：一体化着色 -->
          <div
            class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-2xs border"
            :style="getCommandFolderColor(activeActionCommand)
              ? { backgroundColor: `${getCommandFolderColor(activeActionCommand)}20`, borderColor: `${getCommandFolderColor(activeActionCommand)}40`, color: getCommandFolderColor(activeActionCommand)! }
              : { backgroundColor: 'rgba(245, 158, 11, 0.15)', borderColor: 'rgba(245, 158, 11, 0.3)', color: '#f59e0b' }"
          >
            <i class="fas fa-terminal text-lg"></i>
          </div>

          <!-- 文本与分类 -->
          <div class="min-w-0 flex-1">
            <h4 class="text-sm font-bold text-foreground truncate tracking-tight">
              {{ activeActionCommand.name || activeActionCommand.command }}
            </h4>
            <!-- 所属分类标签与使用计数 -->
            <div class="flex items-center gap-2 text-[11px] text-text-secondary mt-0.5 flex-wrap">
              <span
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                :style="getCommandFolderColor(activeActionCommand)
                  ? { backgroundColor: `${getCommandFolderColor(activeActionCommand)}20`, color: getCommandFolderColor(activeActionCommand)! }
                  : { backgroundColor: 'rgba(148, 163, 184, 0.15)', color: 'var(--color-text-secondary)' }"
              >
                <i class="fas fa-folder text-[9px]"></i>
                <span class="truncate max-w-[120px]">{{ getCommandFolderName(activeActionCommand) }}</span>
              </span>
              <span v-if="activeActionCommand.usage_count !== undefined" class="text-text-secondary/70">
                • {{ t('quickCommands.usageCount', '使用次数') }}: {{ activeActionCommand.usage_count }}
              </span>
            </div>
          </div>
        </div>
        <!-- 指令代码预览栏 -->
        <div v-if="activeActionCommand?.command" class="px-4 py-1.5 bg-header/40 border-b border-border/30 flex items-center justify-between gap-2">
          <code class="text-[11px] font-mono text-text-secondary truncate flex-1 select-all">
            {{ activeActionCommand.command }}
          </code>
          <button
            type="button"
            @click.stop="copyCommand(activeActionCommand!.command)"
            class="text-[11px] text-primary hover:underline shrink-0 flex items-center gap-1 cursor-pointer"
          >
            <i class="fas fa-copy text-[10px]"></i>
            <span>{{ t('commandHistory.copy', '复制') }}</span>
          </button>
        </div>
      </template>

      <!-- 抽屉内容区 (大拇指友好大触控热区) -->
      <div v-if="activeActionCommand" class="p-3.5 overflow-y-auto space-y-1.5 max-h-[60dvh] overscroll-contain">
        <!-- 视图 1：主操作列表 -->
        <template v-if="actionSheetView === 'menu'">
          <!-- 1. 立即执行 -->
          <button
            type="button"
            @click="handleActionSheetItemAction('execute')"
            class="w-full h-12 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer bg-card/40 border border-border/30"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-500 flex items-center justify-center">
                <i class="fas fa-play text-xs"></i>
              </div>
              <div class="text-left">
                <div class="text-sm font-medium leading-tight text-foreground">{{ t('quickCommands.form.execute', '执行指令') }}</div>
                <div class="text-[11px] text-text-secondary leading-tight mt-0.5">{{ t('quickCommands.actions.executeDesc', '在当前活跃终端发送并运行') }}</div>
              </div>
            </div>
            <i class="fas fa-chevron-right text-xs text-text-secondary/30"></i>
          </button>

          <!-- 2. 编辑指令 -->
          <button
            type="button"
            @click="handleActionSheetItemAction('edit')"
            class="w-full h-12 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer bg-card/40 border border-border/30"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-sky-500/15 text-sky-400 flex items-center justify-center">
                <i class="fas fa-edit text-xs"></i>
              </div>
              <div class="text-left">
                <div class="text-sm font-medium leading-tight text-foreground">{{ t('common.edit', '编辑指令') }}</div>
                <div class="text-[11px] text-text-secondary leading-tight mt-0.5">{{ t('quickCommands.actions.editDesc', '修改指令名称、内容或分类') }}</div>
              </div>
            </div>
            <i class="fas fa-chevron-right text-xs text-text-secondary/30"></i>
          </button>

          <!-- 3. 复制命令 -->
          <button
            type="button"
            @click="handleActionSheetItemAction('copy')"
            class="w-full h-12 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer bg-card/40 border border-border/30"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-purple-500/15 text-purple-400 flex items-center justify-center">
                <i class="fas fa-copy text-xs"></i>
              </div>
              <div class="text-left">
                <div class="text-sm font-medium leading-tight text-foreground">{{ t('commandHistory.copy', '复制指令') }}</div>
                <div class="text-[11px] text-text-secondary leading-tight mt-0.5">{{ t('quickCommands.actions.copyDesc', '将指令纯文本复制到剪贴板') }}</div>
              </div>
            </div>
            <i class="fas fa-chevron-right text-xs text-text-secondary/30"></i>
          </button>

          <!-- 4. 发送到全部会话 -->
          <button
            type="button"
            @click="handleActionSheetItemAction('sendToAllSessions')"
            class="w-full h-12 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer bg-card/40 border border-border/30"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center">
                <i class="fas fa-paper-plane text-xs"></i>
              </div>
              <div class="text-left">
                <div class="text-sm font-medium leading-tight text-foreground">{{ t('quickCommands.actions.sendToAllSessions', '发送到全部会话') }}</div>
                <div class="text-[11px] text-text-secondary leading-tight mt-0.5">{{ t('quickCommands.actions.sendToAllDesc', '广播发送到所有活跃的 SSH 终端') }}</div>
              </div>
            </div>
            <i class="fas fa-chevron-right text-xs text-text-secondary/30"></i>
          </button>

          <!-- 5. 移至文件夹 (点击切换视图) -->
          <button
            type="button"
            @click="actionSheetView = 'moveFolder'"
            class="w-full h-12 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:bg-header/80 active:scale-[0.99] transition-all cursor-pointer bg-card/40 border border-border/30"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center">
                <i class="fas fa-folder-tree text-xs"></i>
              </div>
              <div class="text-left">
                <div class="text-sm font-medium leading-tight text-foreground">{{ t('folders.moveToFolder', '移至文件夹') }}</div>
                <div class="text-[11px] text-text-secondary leading-tight mt-0.5">当前: {{ getCommandFolderName(activeActionCommand) }}</div>
              </div>
            </div>
            <div class="flex items-center gap-1.5 text-xs text-text-secondary/60">
              <i class="fas fa-chevron-right text-xs"></i>
            </div>
          </button>

          <!-- 分割线 -->
          <div class="h-px bg-border/40 my-1"></div>

          <!-- 6. 删除指令 (危险项) -->
          <button
            type="button"
            @click="handleActionSheetItemAction('delete')"
            class="w-full h-12 px-3.5 rounded-xl flex items-center justify-between text-error hover:bg-error/10 active:bg-error/20 active:scale-[0.99] transition-all cursor-pointer bg-error/5 border border-error/20"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-error/15 text-error flex items-center justify-center">
                <i class="fas fa-trash-alt text-xs"></i>
              </div>
              <div class="text-left">
                <div class="text-sm font-medium leading-tight text-error">{{ t('common.delete', '删除指令') }}</div>
                <div class="text-[11px] text-error/70 leading-tight mt-0.5">{{ t('quickCommands.actions.deleteDesc', '永久移除此快捷指令') }}</div>
              </div>
            </div>
            <i class="fas fa-chevron-right text-xs text-error/40"></i>
          </button>
        </template>

        <!-- 视图 2：选择移动目标文件夹 -->
        <template v-else-if="actionSheetView === 'moveFolder'">
          <div class="flex items-center justify-between pb-2 mb-2 border-b border-border/40">
            <button
              type="button"
              @click="actionSheetView = 'menu'"
              class="flex items-center gap-1.5 text-xs text-primary font-medium hover:underline cursor-pointer"
            >
              <i class="fas fa-arrow-left text-[11px]"></i>
              <span>{{ t('common.back', '返回') }}</span>
            </button>
            <span class="text-xs font-semibold text-foreground">{{ t('folders.selectDestinationFolder', '选择目标文件夹') }}</span>
            <div class="w-8"></div>
          </div>

          <div class="space-y-1.5 max-h-[45dvh] overflow-y-auto pr-1">
            <!-- 未分类选项 -->
            <button
              type="button"
              @click="handleActionSheetMoveToFolder(null)"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:scale-[0.99] transition-all cursor-pointer border"
              :class="getCommandPrimaryFolderId(activeActionCommand) === null
                ? 'bg-primary/10 border-primary text-primary font-medium'
                : 'bg-card/40 border-border/30'"
            >
              <div class="flex items-center gap-2.5">
                <i class="fas fa-inbox text-sm text-text-secondary"></i>
                <span class="text-xs">{{ t('folders.uncategorized', '未分类') }}</span>
              </div>
              <i v-if="getCommandPrimaryFolderId(activeActionCommand) === null" class="fas fa-check text-xs text-primary"></i>
            </button>

            <!-- 各文件夹选项 -->
            <button
              v-for="folder in quickCommandTagsStore.folders"
              :key="folder.id"
              type="button"
              @click="handleActionSheetMoveToFolder(folder.id)"
              class="w-full h-11 px-3.5 rounded-xl flex items-center justify-between text-foreground hover:bg-header/50 active:scale-[0.99] transition-all cursor-pointer border"
              :class="getCommandPrimaryFolderId(activeActionCommand) === folder.id
                ? 'bg-primary/10 border-primary text-primary font-medium'
                : 'bg-card/40 border-border/30'"
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <i
                  class="fas fa-folder text-sm shrink-0"
                  :style="{ color: getFolderColorById(folder.id) || '#f59e0b' }"
                ></i>
                <span class="text-xs truncate">{{ folder.name }}</span>
              </div>
              <i v-if="getCommandPrimaryFolderId(activeActionCommand) === folder.id" class="fas fa-check text-xs text-primary"></i>
            </button>
          </div>
        </template>

        <!-- 底部取消大按钮 -->
        <div class="pt-2">
          <button
            type="button"
            @click="closeCommandActionSheet"
            class="w-full h-11 rounded-xl bg-header/60 hover:bg-header border border-border/40 font-medium text-sm text-foreground active:scale-[0.99] transition-all flex items-center justify-center cursor-pointer"
          >
            {{ t('common.cancel', '取消') }}
          </button>
        </div>
      </div>
    </MobileBottomSheet>

    <!-- 新建文件夹弹窗 -->
    <div
      v-if="isCreatingFolderModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      @click.self="isCreatingFolderModal = false"
    >
      <div
        class="bg-background border border-border/80 rounded-2xl shadow-2xl p-5 w-80 max-w-[90vw] animate-fadeIn"
        @click.stop
      >
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
import { useQuickCommandTagsStore } from '../stores/quickCommandTags.store'; 
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useI18n } from 'vue-i18n';
import { copyToClipboard } from '../utils/clipboard';
import { resolveFolderColor, resolveCommandFolderColor, countCommandsInFolder } from '../utils/quickCommandDisplay';
import { useQuickCommandExecution } from '../composables/quickCommands/useQuickCommandExecution';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import AddEditQuickCommandForm from '../components/AddEditQuickCommandForm.vue';
import DeleteQuickCommandFolderModal from '../components/DeleteQuickCommandFolderModal.vue';
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
import MobileBottomSheet from '../components/common/MobileBottomSheet.vue';
import { resolveEffectiveColor, getItemColoredCardStyle } from '../utils/colorUtils';

const quickCommandsStore = useQuickCommandsStore();
const quickCommandTagsStore = useQuickCommandTagsStore(); 
const uiNotificationsStore = useUiNotificationsStore();
const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const focusSwitcherStore = useFocusSwitcherStore();
const settingsStore = useSettingsStore();
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const sessionStore = useSessionStore(); 
const connectionsStore = useConnectionsStore();

// 文件夹背景调色板状态
const activeFolderColorPickerId = ref<number | null>(null);
const activeFolderColorPickerTriggerEl = ref<HTMLElement | null>(null);

const toggleFolderColorPicker = (tagId: number, e: Event) => {
  e.stopPropagation();
  if (activeFolderColorPickerId.value === tagId) {
    activeFolderColorPickerId.value = null;
    activeFolderColorPickerTriggerEl.value = null;
  } else {
    activeFolderColorPickerId.value = tagId;
    activeFolderColorPickerTriggerEl.value = (e.currentTarget as HTMLElement) || (e.target as HTMLElement);
  }
};

const handleUpdateFolderColor = async (tagId: number, color: string | null) => {
  await quickCommandTagsStore.updateFolderColor(tagId, color);
  activeFolderColorPickerId.value = null;
  activeFolderColorPickerTriggerEl.value = null;
};

const getFolderColorById = (tagId?: number | null): string | null =>
  resolveFolderColor(quickCommandTagsStore.folders, tagId);

const getCommandFolderColor = (cmd: QuickCommandFE, groupTagId?: number | null): string | null =>
  resolveCommandFolderColor(quickCommandTagsStore.folders, cmd, groupTagId);

const getCommandCardStyle = (cmd: QuickCommandFE, groupTagId?: number | null) => {
  const folderColor = getCommandFolderColor(cmd, groupTagId);
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

// +++ State for inline tag editing +++
const editingTagId = ref<number | null | 'untagged'>(null);
const editedTagName = ref('');
const tagInputRefs = ref(new Map<string | number, HTMLInputElement | null>());

// +++ 移动端专属快捷指令动作抽屉 (Action Sheet) 状态 +++
const isActionSheetVisible = ref(false);
const activeActionCommand = ref<QuickCommandFE | null>(null);
const actionSheetView = ref<'menu' | 'moveFolder'>('menu');
const quickCommandContextTargetCommand = activeActionCommand; // 保持向后兼容别名

// +++ 文件夹弹窗状态 +++
const isCreatingFolderModal = ref(false);
const newQuickCommandFolderName = ref('');

const localSearchTerm = ref(quickCommandsStore.searchTerm);
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// --- 从 Store 获取状态和 Getter ---
const searchTerm = computed(() => quickCommandsStore.searchTerm);
const sortBy = computed(() => quickCommandsStore.sortBy);
// Use the new grouped getter
const filteredAndGroupedCommands = computed(() => quickCommandsStore.filteredAndGroupedCommands);
const isLoading = computed(() => quickCommandsStore.isLoading);

watch(searchTerm, (newVal) => {
  if (newVal !== localSearchTerm.value) {
    localSearchTerm.value = newVal;
  }
});

const { selectedIndex: storeSelectedIndex, flatVisibleCommands, expandedGroups } = storeToRefs(quickCommandsStore);
const {
  showQuickCommandTagsBoolean,
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

// 后端异步拉取完成时，更新至最新持久化设置
watch(() => componentStateStore.isLoaded, () => {
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
    case 'pills': return 'fa-tags';
    default: return 'fa-table-cells-large';
  }
});

const viewModeTitle = computed(() => {
  const modeKey = currentViewMode.value;
  const modeName = t(`quickCommands.viewMode.${modeKey}`, modeKey);
  return t('quickCommands.viewMode.toggle', { mode: modeName }, `切换视图 (当前: ${modeName})`);
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



// --- 生命周期钩子 ---
onMounted(async () => { // Make onMounted async
    // 初始化组件实例后端状态仓库
    componentStateStore.initialize();
    // Load expanded groups state first
    quickCommandsStore.loadExpandedGroups();
    // Then fetch commands (which might initialize expandedGroups for new groups)
    await quickCommandsStore.fetchQuickCommands();
    // Also fetch the quick command tags using the correct store instance
    await quickCommandTagsStore.fetchTags();
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
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  document.removeEventListener('click', closeQuickCommandContextMenu);
  // +++ 调用保存的注销函数 +++
  if (unregisterFocus) {
    unregisterFocus();
  }
});


// +++ Watcher to focus input when editing starts +++
watch(editingTagId, async (newId) => {
    if (newId !== null) {
        await nextTick();
        const inputRef = tagInputRefs.value.get(newId);
        if (inputRef) {
            inputRef.focus();
            inputRef.select();
        } else {
             console.error(`[QuickCmdView] Watcher: Input ref for ID ${newId} not found.`);
        }
    }
});

// 监听显示模式变化，重置选择
watch(showQuickCommandTagsBoolean, () => {
    quickCommandsStore.resetSelection();
});


// --- 事件处理 ---

// 更新搜索词 (带 120ms 防抖，消除连续打字掉帧)
const updateSearchTerm = (event: Event) => {
  const target = event.target as HTMLInputElement;
  localSearchTerm.value = target.value;
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    quickCommandsStore.setSearchTerm(localSearchTerm.value);
    searchDebounceTimer = null;
  }, 120);
};

// +++ 重构滚动逻辑 +++
const scrollToSelected = async (index: number) => {
    await nextTick(); // 等待 DOM 更新
    // 使用 store 的 flatVisibleCommands
    if (index < 0 || !commandListContainerRef.value || !flatVisibleCommands.value[index]) return;

    const selectedCommandId = flatVisibleCommands.value[index].id;
    const listContainer = commandListContainerRef.value;

    // Find the element using the data attribute (works for grid, list, and pills)
    const selectedElement = listContainer.querySelector(`[data-command-id="${selectedCommandId}"]`) as HTMLElement;

    if (selectedElement) {
        selectedElement.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
        });
    } else {
        console.warn(`[QuickCmdView] scrollToSelected: Could not find element for command ID ${selectedCommandId}`);
    }
};

// Watch for changes in the store's selectedIndex and scroll
watch(storeSelectedIndex, (newIndex) => {
  scrollToSelected(newIndex);
});

// Keyboard navigation now operates on the flat visible list from the store
const handleSearchInputKeydown = (event: KeyboardEvent) => {
    // 使用 store 的 flatVisibleCommands
    const commands = flatVisibleCommands.value;
    if (!commands.length) return;

    switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      quickCommandsStore.selectNextCommand(); // Use store action
      // scrollToSelected is handled by watcher
      break;
    case 'ArrowUp':
      event.preventDefault();
      quickCommandsStore.selectPreviousCommand(); // Use store action
      // scrollToSelected is handled by watcher
      break;
    case 'Enter':
      event.preventDefault();
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
        quickCommandsStore.setSearchTerm(localSearchTerm.value);
      }
      // 使用 store 的 storeSelectedIndex
      if (storeSelectedIndex.value >= 0 && storeSelectedIndex.value < commands.length) {
        executeCommand(commands[storeSelectedIndex.value]);
      }
      break;
  }
};

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
const toggleGroup = (groupName: string) => {
    quickCommandsStore.toggleGroup(groupName);
    // After toggling, selection might become invalid if the selected item is now hidden
    // Reset selection or check if the selected item is still visible
    nextTick(() => { // Wait for DOM update potentially caused by v-show
         // 使用 store 的 flatVisibleCommands 和 storeSelectedIndex
         const selectedCmdId = storeSelectedIndex.value >= 0 && flatVisibleCommands.value[storeSelectedIndex.value]
             ? flatVisibleCommands.value[storeSelectedIndex.value].id
             : null;
         if (selectedCmdId !== null) {
             const newIndex = flatVisibleCommands.value.findIndex(cmd => cmd.id === selectedCmdId);
             if (newIndex === -1) { // Selected item is no longer visible
                 quickCommandsStore.resetSelection();
             } else {
                 // Update index if it shifted, though usually reset is safer/simpler
                 // storeSelectedIndex.value = newIndex;
             }
         }
    });
};

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


const openAddForm = () => {
  commandToEdit.value = null;
  isFormVisible.value = true;
};

const openEditForm = (command: QuickCommandFE) => {
  commandToEdit.value = command;
  isFormVisible.value = true;
};

const closeForm = () => {
  isFormVisible.value = false;
  commandToEdit.value = null;
};

const confirmDelete = async (command: QuickCommandFE) => {
  const confirmed = await showConfirmDialog({
    message: t('quickCommands.confirmDelete', { name: command.name || command.command })
  });
  if (confirmed) {
    quickCommandsStore.deleteQuickCommand(command.id);
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

// +++ Methods for inline tag editing +++
const setTagInputRef = (el: any, id: string | number) => {
  if (el) {
    tagInputRefs.value.set(id, el as HTMLInputElement);
  } else {
    tagInputRefs.value.delete(id);
  }
};

const startEditingTag = (tagId: number | null, currentName: string) => {
  editingTagId.value = tagId === null ? 'untagged' : tagId;
  editedTagName.value = tagId === null ? '' : currentName; // Clear input for "Untagged"
  // Focus logic is handled by the watcher
};

const finishEditingTag = async () => {
  const currentEditingId = editingTagId.value;
  const newName = editedTagName.value.trim();
  const originalGroup = filteredAndGroupedCommands.value.find(g => g.tagId === currentEditingId); // Find original group data

  // Basic validation
  if (newName === '' && currentEditingId !== 'untagged') {
    cancelEditingTag();
    return;
  }
   if (newName === '' && currentEditingId === 'untagged') {
     cancelEditingTag();
     return;
   }

  let operationSuccess = false;

  try {
    if (currentEditingId === 'untagged') {
      // --- Create new tag and assign commands ---
      console.log(`[QuickCmdView] Creating new tag: ${newName}`);
      const newTag = await quickCommandTagsStore.addTag(newName);
      if (newTag) {
        operationSuccess = true;
        uiNotificationsStore.showSuccess(t('quickCommands.tags.createSuccess')); // Use specific translation key
        const untaggedGroup = filteredAndGroupedCommands.value.find(g => g.tagId === null);
        const commandIdsToAssign = untaggedGroup ? untaggedGroup.commands.map(c => c.id) : [];

        if (commandIdsToAssign.length > 0) {
          console.log(`[QuickCmdView] Assigning ${commandIdsToAssign.length} commands to new tag ID: ${newTag.id}`);
          console.log(`[QuickCmdView] Command IDs to assign: ${JSON.stringify(commandIdsToAssign)}`); 
          // Call the store action to assign commands to the new tag
          const assignSuccess = await quickCommandsStore.assignCommandsToTagAction(commandIdsToAssign, newTag.id);
          if (assignSuccess) {
            // Success/Error Notifications and list refresh are handled within the store action
            console.log(`[QuickCmdView] assignCommandsToTagAction reported success.`);
          } else {
             console.error(`[QuickCmdView] assignCommandsToTagAction reported failure.`);
             // Optionally show a specific error here if the store action doesn't cover all cases
          }
          // Remove TODO and temporary warning/refresh
          // console.warn("TODO: Implement assignCommandsToTagAction in quickCommands.store and backend");
          // uiNotificationsStore.showWarning("标签已创建，但指令分配功能尚未实现");
          // await quickCommandsStore.fetchQuickCommands(); // Store action handles refresh
        } else {
          uiNotificationsStore.showInfo(t('quickCommands.tags.noCommandsToAssign'));
        }

        // Update expanded group state
        const untaggedGroupName = t('quickCommands.untagged', '未标记');
        if (expandedGroups.value[untaggedGroupName] !== undefined) {
          const currentState = expandedGroups.value[untaggedGroupName];
          delete expandedGroups.value[untaggedGroupName]; // Remove old key
          expandedGroups.value[newName] = currentState; // Add new key
        }
      }
      // addTag failure handled in store
    } else if (typeof currentEditingId === 'number') {
      // --- Update existing tag ---
      const originalTagName = originalGroup?.groupName;
      if (!originalTagName) {
         console.error(`[QuickCmdView] Cannot find original group name for tag ID ${currentEditingId}`);
         cancelEditingTag();
         return;
      }
      if (originalTagName === newName) {
        operationSuccess = true; // No change needed
      } else {
        console.log(`[QuickCmdView] Updating tag ID ${currentEditingId} from "${originalTagName}" to "${newName}"`);
        const updateResult = await quickCommandTagsStore.updateTag(currentEditingId, newName);
        if (updateResult) {
          operationSuccess = true;
          // uiNotificationsStore.showSuccess(t('quickCommands.tags.updateSuccess'));
          // Update expanded group state
          if (expandedGroups.value[originalTagName] !== undefined) {
            const currentState = expandedGroups.value[originalTagName];
            delete expandedGroups.value[originalTagName];
            expandedGroups.value[newName] = currentState;
          }
           // Refresh commands to reflect potential grouping changes if names clashed etc.
           await quickCommandsStore.fetchQuickCommands();
        }
        // updateTag failure handled in store
      }
    }
  } catch (error: any) {
    console.error("[QuickCmdView] Error during finishEditingTag:", error);
    uiNotificationsStore.showError(t('common.unexpectedError'));
  } finally {
    editingTagId.value = null; // Exit edit mode regardless of success
  }
};

const cancelEditingTag = () => {
  editingTagId.value = null;
};

// --- 移动端快捷指令专用操作抽屉控制 ---
const openCommandActionSheet = (command: QuickCommandFE) => {
  activeActionCommand.value = command;
  actionSheetView.value = 'menu';
  isActionSheetVisible.value = true;
};

const closeCommandActionSheet = () => {
  isActionSheetVisible.value = false;
  activeActionCommand.value = null;
  actionSheetView.value = 'menu';
};

// 获取命令所属首个文件夹 ID
const getCommandPrimaryFolderId = (command?: QuickCommandFE | null): number | null => {
  if (!command || !command.tagIds || command.tagIds.length === 0) return null;
  return command.tagIds[0];
};

// 获取命令所属文件夹名称
const getCommandFolderName = (command?: QuickCommandFE | null): string => {
  const folderId = getCommandPrimaryFolderId(command);
  if (folderId === null) {
    return t('folders.uncategorized', '未分类');
  }
  const folder = quickCommandTagsStore.folders.find(f => f.id === folderId);
  return folder?.name || t('folders.uncategorized', '未分类');
};

// 在操作抽屉中选择移动到文件夹
const handleActionSheetMoveToFolder = async (folderId: number | null) => {
  if (!activeActionCommand.value) return;
  const cmd = activeActionCommand.value;
  await handleMoveCommandToFolder(cmd, folderId);
  closeCommandActionSheet();
};

// 在操作抽屉中触发动作
const handleActionSheetItemAction = (action: QuickCommandMenuAction) => {
  if (!activeActionCommand.value) return;
  const command = activeActionCommand.value;
  closeCommandActionSheet();
  handleQuickCommandMenuAction(action, command);
};

// --- 长按检测 (Touch Long Press) 与右键菜单统一控制 ---
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartX = 0;
let touchStartY = 0;
const isLongPressActive = ref(false);

// 触屏长按处理 (移动端/触摸屏)
const handleItemTouchStart = (event: TouchEvent, command: QuickCommandFE) => {
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  isLongPressActive.value = false;

  if (longPressTimer) {
    clearTimeout(longPressTimer);
  }
  longPressTimer = setTimeout(() => {
    isLongPressActive.value = true;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate?.(40);
    }
    openCommandActionSheet(command);
  }, 400);
};

const handleItemTouchMove = (event: TouchEvent) => {
  if (!longPressTimer) return;
  const touch = event.touches[0];
  const deltaX = Math.abs(touch.clientX - touchStartX);
  const deltaY = Math.abs(touch.clientY - touchStartY);
  // 滑移超过 10px 视为滚动页面，取消长按定时器
  if (deltaX > 10 || deltaY > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

const handleItemTouchEnd = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (isLongPressActive.value) {
    // 延迟 150ms 重置标志位，以阻断随后的原生 click 事件触发执行
    setTimeout(() => {
      isLongPressActive.value = false;
    }, 150);
  }
};

// 拦截长按触发后的误触点击
const handleCommandItemClick = (cmd: QuickCommandFE) => {
  if (isLongPressActive.value) {
    isLongPressActive.value = false;
    return;
  }
  executeCommand(cmd);
};

// 右键点击处理 (统一唤起移动端底部动作面板)
const showQuickCommandContextMenu = (event: MouseEvent, command: QuickCommandFE) => {
  event.preventDefault();
  openCommandActionSheet(command);
};

const closeQuickCommandContextMenu = () => {
  closeCommandActionSheet();
};

// 右键/长按菜单动作处理
type QuickCommandMenuAction = 'execute' | 'edit' | 'copy' | 'sendToAllSessions' | 'delete';

const handleQuickCommandMenuAction = (action: QuickCommandMenuAction, command: QuickCommandFE) => {
  closeQuickCommandContextMenu();
  switch (action) {
    case 'execute':
      executeCommand(command);
      break;
    case 'edit':
      openEditForm(command);
      break;
    case 'copy':
      copyCommand(command.command);
      break;
    case 'sendToAllSessions': {
      const activeSshSessions = Array.from(sessionStore.sessions.values()).filter(
        (s: SessionState) => {
          if (s.wsManager.connectionStatus.value !== 'connected') return false;
          const connInfo = connectionsStore.connections.find(c => c.id === Number(s.connectionId));
          return connInfo?.type === 'SSH';
        }
      );

      if (activeSshSessions.length > 0) {
        activeSshSessions.forEach((session: SessionState) => {
          emitWorkspaceEvent('terminal:sendCommand', { sessionId: session.sessionId, command: command.command });
        });
        uiNotificationsStore.addNotification({
          message: t('quickCommands.notifications.sentToAllSessions', { count: activeSshSessions.length }),
          type: 'success',
        });
      } else {
        uiNotificationsStore.addNotification({
          message: t('quickCommands.notifications.noActiveSshSessions'),
          type: 'info',
        });
      }
      break;
    }
    case 'delete':
      confirmDelete(command);
      break;
  }
};

// --- 文件夹管理操作 ---
const openCreateFolderDialog = () => {
  newQuickCommandFolderName.value = '';
  isCreatingFolderModal.value = true;
};

const confirmCreateQuickCommandFolder = async () => {
  const name = newQuickCommandFolderName.value.trim();
  if (!name) return;
  try {
    const created = await quickCommandTagsStore.createFolder(name);
    if (created) {
      uiNotificationsStore.showSuccess(t('folders.folderCreated', '文件夹已创建'));
      await quickCommandTagsStore.fetchTags();
      await quickCommandsStore.fetchQuickCommands();
      isCreatingFolderModal.value = false;
      newQuickCommandFolderName.value = '';
    }
  } catch (error: any) {
    uiNotificationsStore.showError(error?.message || t('common.unexpectedError'));
  }
};

const showDeleteFolderModal = ref(false);
const folderToDelete = ref<{ id: number; name: string } | null>(null);
const isDeletingFolder = ref(false);

const getFolderCommandCount = (folderId: number | 'all' | 'untagged'): number =>
  countCommandsInFolder(quickCommandsStore.quickCommandsList, folderId);

const handleDeleteFolder = (folderId: number, folderName: string, event?: Event) => {
  if (event) event.stopPropagation();
  folderToDelete.value = { id: folderId, name: folderName };
  showDeleteFolderModal.value = true;
};

const handleConfirmDeleteFolder = async (deleteCommands: boolean) => {
  if (!folderToDelete.value) return;
  const fid = folderToDelete.value.id;
  isDeletingFolder.value = true;
  try {
    const success = await quickCommandTagsStore.deleteFolder(fid, deleteCommands);
    if (success) {
      showDeleteFolderModal.value = false;
      folderToDelete.value = null;
      await Promise.all([
        quickCommandTagsStore.fetchTags(),
        quickCommandsStore.fetchQuickCommands()
      ]);
    }
  } catch (error: any) {
    uiNotificationsStore.showError(error?.message || t('common.unexpectedError'));
  } finally {
    isDeletingFolder.value = false;
  }
};

const handleMoveCommandToFolder = async (command: QuickCommandFE, folderId: number | null) => {
  try {
    const success = await quickCommandsStore.moveCommandToFolder(command.id, folderId);
    if (success) {
      uiNotificationsStore.showSuccess(t('folders.movedSuccess', '已成功移动到文件夹'));
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

/* 移动端触摸手势防系统长按原生菜单与优化交互 */
.qc-touch-item {
  -webkit-touch-callout: none !important;
  -webkit-user-select: none !important;
  user-select: none !important;
  touch-action: manipulation;
}
</style>
