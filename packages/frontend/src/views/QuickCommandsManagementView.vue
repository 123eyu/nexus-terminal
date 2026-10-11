<template>
  <div class="flex h-[calc(100vh-3.5rem)] overflow-hidden bg-background">
    <!-- 左侧：文件夹导航面板 -->
    <aside class="w-64 flex-shrink-0 flex flex-col border-r border-border bg-card/40 backdrop-blur-xs select-none">
      <!-- 文件夹面板头部 -->
      <div class="p-3.5 border-b border-border flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="w-6 h-6 rounded-md bg-amber-500/10 text-amber-500 flex items-center justify-center">
            <i class="fas fa-folder text-xs"></i>
          </div>
          <span class="text-xs font-semibold text-foreground tracking-wide uppercase">{{ t('folders.title', '文件夹') }}</span>
        </div>
        <button
          type="button"
          @click="startCreatingFolder"
          class="px-2 py-1 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all flex items-center gap-1 cursor-pointer"
          :title="t('folders.newFolder', '新建文件夹')"
        >
          <i class="fas fa-plus text-[10px]"></i>
          <span>{{ t('common.create', '新建') }}</span>
        </button>
      </div>

      <!-- 快速新建文件夹行内输入框 -->
      <div v-if="isCreatingFolder" class="p-2 border-b border-border bg-card animate-fadeIn">
        <div class="flex items-center gap-1.5">
          <input
            ref="newFolderInputRef"
            v-model="newFolderName"
            type="text"
            :placeholder="t('folders.newFolderPlaceholder', '文件夹名称...')"
            class="flex-1 min-w-0 px-2 py-1 text-xs border border-primary rounded-md bg-input text-foreground focus:outline-none"
            @keydown.enter.prevent="handleCreateFolderConfirm"
            @keydown.esc.prevent="isCreatingFolder = false"
          />
          <button
            type="button"
            @click="handleCreateFolderConfirm"
            class="px-2 py-1 text-xs bg-primary text-white rounded-md hover:bg-primary-hover cursor-pointer"
          >
            <i class="fas fa-check text-[10px]"></i>
          </button>
          <button
            type="button"
            @click="isCreatingFolder = false"
            class="px-2 py-1 text-xs text-text-secondary hover:text-foreground rounded-md hover:bg-muted cursor-pointer"
          >
            <i class="fas fa-times text-[10px]"></i>
          </button>
        </div>
      </div>

      <!-- 文件夹列表区 -->
      <div class="flex-1 overflow-y-auto p-2 space-y-0.5">
        <!-- 1. 全部指令 -->
        <div
          @click="activeFolder = 'all'"
          @dragover.prevent="dragOverFolderId = 'all'"
          @dragleave="dragOverFolderId = null"
          @drop.prevent="handleDropOnFolder('all')"
          class="group flex items-center justify-between px-3 h-9 rounded-lg text-xs font-medium cursor-pointer transition-colors duration-150 border border-transparent"
          :class="[
            activeFolder === 'all'
              ? 'bg-primary/15 text-primary font-semibold border-primary/20'
              : 'text-text-secondary hover:bg-muted hover:text-foreground',
            dragOverFolderId === 'all' ? 'ring-2 ring-primary ring-inset' : ''
          ]"
        >
          <div class="flex items-center gap-2.5 truncate">
            <i class="fas fa-layer-group text-xs w-4 text-center"></i>
            <span class="truncate">{{ t('folders.allCommands', '全部指令') }}</span>
          </div>
          <span class="text-[11px] px-1.5 h-5 min-w-[20px] flex items-center justify-center rounded-full bg-muted/60 text-text-secondary group-hover:text-foreground">
            {{ allCommandsCount }}
          </span>
        </div>

        <!-- 2. 未分类 -->
        <div
          @click="activeFolder = 'uncategorized'"
          @dragover.prevent="dragOverFolderId = 'uncategorized'"
          @dragleave="dragOverFolderId = null"
          @drop.prevent="handleDropOnFolder('uncategorized')"
          class="group flex items-center justify-between px-3 h-9 rounded-lg text-xs font-medium cursor-pointer transition-colors duration-150 border border-transparent"
          :class="[
            activeFolder === 'uncategorized'
              ? 'bg-primary/15 text-primary font-semibold border-primary/20'
              : 'text-text-secondary hover:bg-muted hover:text-foreground',
            dragOverFolderId === 'uncategorized' ? 'ring-2 ring-primary ring-inset' : ''
          ]"
        >
          <div class="flex items-center gap-2.5 truncate">
            <i class="fas fa-inbox text-xs w-4 text-center"></i>
            <span class="truncate">{{ t('folders.uncategorized', '未分类') }}</span>
          </div>
          <span class="text-[11px] px-1.5 h-5 min-w-[20px] flex items-center justify-center rounded-full bg-muted/60 text-text-secondary group-hover:text-foreground">
            {{ uncategorizedCommandsCount }}
          </span>
        </div>

        <div class="h-px bg-border/40 my-1 mx-1"></div>

        <!-- 3. 自定义文件夹 -->
        <div
          v-for="folder in quickCommandTagsStore.folders"
          :key="folder.id"
          @click="editingFolderId !== folder.id ? activeFolder = folder.id : null"
          @dragover.prevent="dragOverFolderId = folder.id"
          @dragleave="dragOverFolderId = null"
          @drop.prevent="handleDropOnFolder(folder.id)"
          class="group relative flex items-center justify-between px-3 h-9 rounded-lg text-xs font-medium cursor-pointer transition-colors duration-150 border border-transparent"
          :class="[
            activeFolder === folder.id
              ? 'bg-primary/15 text-primary font-semibold border-primary/20'
              : 'text-text-secondary hover:bg-muted hover:text-foreground',
            dragOverFolderId === folder.id ? 'ring-2 ring-primary ring-inset' : ''
          ]"
        >
          <!-- 行内重命名模式 -->
          <div v-if="editingFolderId === folder.id" class="flex items-center gap-1.5 w-full h-full" @click.stop>
            <input
              ref="editFolderInputRef"
              v-model="editingFolderName"
              type="text"
              class="flex-1 min-w-0 px-2 py-0.5 text-xs border border-primary rounded bg-input text-foreground focus:outline-none"
              @keydown.enter.prevent="handleFinishRenameFolder"
              @keydown.esc.prevent="editingFolderId = null"
              @blur="handleFinishRenameFolder"
            />
          </div>

          <!-- 常态展示模式 -->
          <template v-else>
            <div class="flex items-center gap-2.5 truncate min-w-0 flex-1 mr-1">
              <!-- 文件夹色标圆点 -->
              <span
                v-if="folder.background_color"
                class="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-xs ring-1 ring-white/20"
                :style="{ backgroundColor: folder.background_color }"
              ></span>
              <i
                v-else
                class="fas fa-folder text-xs w-4 text-center text-amber-400 group-hover:text-amber-500 transition-colors flex-shrink-0"
              ></i>

              <span class="truncate">{{ folder.name }}</span>
            </div>

            <div class="flex items-center gap-1 flex-shrink-0 h-6">
              <!-- Hover 动作区：设色、重命名、删除 -->
              <div class="hidden group-hover:flex items-center gap-0.5" @click.stop>
                <!-- 文件夹调色板 -->
                <div class="relative inline-flex items-center" @click.stop>
                  <button
                    type="button"
                    @click.stop="toggleFolderColorPicker(folder.id, $event)"
                    class="w-6 h-6 p-0 rounded text-text-secondary hover:text-foreground hover:bg-background/80 text-[10px] flex items-center justify-center transition-colors cursor-pointer"
                    :title="t('folders.folderColor', '文件夹背景颜色')"
                  >
                    <i class="fas fa-palette"></i>
                  </button>
                  <ColorPickerPopover
                    :visible="activeColorPickerFolderId === folder.id"
                    :trigger-el="activeColorPickerTriggerEl"
                    :model-value="folder.background_color"
                    @update:model-value="handleSaveFolderColor(folder.id, $event)"
                    @close="activeColorPickerFolderId = null; activeColorPickerTriggerEl = null"
                  />
                </div>

                <!-- 重命名 -->
                <button
                  type="button"
                  @click.stop="handleStartRenameFolder(folder)"
                  class="w-6 h-6 p-0 rounded text-text-secondary hover:text-foreground hover:bg-background/80 text-[10px] flex items-center justify-center transition-colors cursor-pointer"
                  :title="t('folders.renameFolder', '重命名文件夹')"
                >
                  <i class="fas fa-pencil-alt"></i>
                </button>

                <!-- 删除 -->
                <button
                  type="button"
                  @click.stop="handleDeleteFolder(folder)"
                  class="w-6 h-6 p-0 rounded text-text-secondary hover:text-error hover:bg-background/80 text-[10px] flex items-center justify-center transition-colors cursor-pointer"
                  :title="t('folders.deleteFolder', '删除文件夹')"
                >
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>

              <!-- 数量角标 (非 Hover 或常态) -->
              <span class="text-[11px] px-1.5 h-5 min-w-[20px] flex items-center justify-center rounded-full bg-muted/60 text-text-secondary group-hover:hidden">
                {{ getFolderCommandsCount(folder.id) }}
              </span>
            </div>
          </template>
        </div>
      </div>
    </aside>

    <!-- 右侧：指令内容工作区 -->
    <main class="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
      <!-- 顶部控制条 -->
      <div class="p-3.5 border-b border-border flex items-center justify-between gap-3 flex-shrink-0 bg-card/20 backdrop-blur-xs">
        <!-- 标题与统计 -->
        <div class="flex items-center gap-2 min-w-0">
          <h2 class="text-base font-semibold text-foreground truncate">
            {{ activeFolderTitle }}
          </h2>
          <span class="text-xs px-2 py-0.5 rounded-full bg-muted text-text-secondary font-medium">
            {{ displayedCommands.length }}
          </span>
        </div>

        <!-- 右侧工具栏：搜索、排序、视图切换、新建指令 -->
        <div class="flex items-center gap-2 flex-shrink-0">
          <!-- 搜索框 -->
          <div class="relative w-48 sm:w-64">
            <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-xs text-text-secondary"></i>
            <input
              type="text"
              v-model="searchQuery"
              :placeholder="t('quickCommands.searchPlaceholder', '搜索名称或指令...')"
              class="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-border/60 bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all shadow-xs"
            />
            <button
              v-if="searchQuery"
              @click="searchQuery = ''"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-text-secondary hover:text-foreground cursor-pointer"
            >
              <i class="fas fa-times"></i>
            </button>
          </div>

          <!-- 排序切换 -->
          <button
            type="button"
            @click="toggleSortBy"
            class="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border/60 bg-card hover:bg-muted text-text-secondary hover:text-foreground transition-all flex items-center gap-1.5 cursor-pointer shadow-xs"
            :title="sortButtonTitle"
          >
            <i :class="sortButtonIcon"></i>
            <span class="hidden md:inline">{{ sortButtonText }}</span>
          </button>

          <!-- 视图模式切换 -->
          <div class="flex items-center border border-border/60 rounded-lg p-0.5 bg-card shadow-xs">
            <button
              type="button"
              @click="viewMode = 'grid'"
              class="px-2 py-1 text-xs rounded-md transition-colors cursor-pointer"
              :class="viewMode === 'grid' ? 'bg-primary text-white shadow-xs' : 'text-text-secondary hover:text-foreground'"
              :title="t('quickCommands.viewModeGrid', '网格视图')"
            >
              <i class="fas fa-th-large"></i>
            </button>
            <button
              type="button"
              @click="viewMode = 'pills'"
              class="px-2 py-1 text-xs rounded-md transition-colors cursor-pointer"
              :class="viewMode === 'pills' ? 'bg-primary text-white shadow-xs' : 'text-text-secondary hover:text-foreground'"
              :title="t('quickCommands.viewModePills', '药丸流式视图')"
            >
              <i class="fas fa-capsules"></i>
            </button>
            <button
              type="button"
              @click="viewMode = 'list'"
              class="px-2 py-1 text-xs rounded-md transition-colors cursor-pointer"
              :class="viewMode === 'list' ? 'bg-primary text-white shadow-xs' : 'text-text-secondary hover:text-foreground'"
              :title="t('quickCommands.viewModeList', '列表视图')"
            >
              <i class="fas fa-bars"></i>
            </button>
          </div>

          <!-- 新建指令按钮 -->
          <button
            type="button"
            @click="openAddCommandModal"
            class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary text-white hover:bg-primary-hover active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
          >
            <i class="fas fa-plus text-[11px]"></i>
            <span>{{ t('quickCommands.add', '添加快捷指令') }}</span>
          </button>
        </div>
      </div>

      <!-- 内容卡片流与网格 -->
      <div class="flex-1 overflow-y-auto p-4">
        <!-- 加载中状态 -->
        <div v-if="quickCommandsStore.isLoading" class="flex flex-col items-center justify-center h-64 text-text-secondary">
          <i class="fas fa-circle-notch fa-spin text-2xl mb-3 text-primary"></i>
          <span class="text-xs">{{ t('common.loading', '加载中...') }}</span>
        </div>

        <!-- 空数据状态 -->
        <div v-else-if="displayedCommands.length === 0" class="flex flex-col items-center justify-center h-64 text-text-secondary">
          <div class="w-12 h-12 rounded-2xl bg-muted/50 flex items-center justify-center mb-3">
            <i class="fas fa-terminal text-xl text-text-secondary/60"></i>
          </div>
          <p class="text-sm font-medium text-foreground mb-1">
            {{ searchQuery ? t('quickCommands.noResults', '未找到匹配的快捷指令') : t('quickCommands.empty', '暂无快捷指令') }}
          </p>
          <p class="text-xs text-text-secondary mb-4 max-w-sm text-center">
            {{ searchQuery ? t('quickCommands.tryAnotherSearch', '请尝试调整搜索关键词') : t('quickCommands.createFirstInFolder', '在当前文件夹中创建您的第一条常用指令吧') }}
          </p>
          <button
            v-if="!searchQuery"
            type="button"
            @click="openAddCommandModal"
            class="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover shadow-xs cursor-pointer"
          >
            <i class="fas fa-plus mr-1"></i>
            {{ t('quickCommands.addFirst', '新建指令') }}
          </button>
        </div>

        <!-- 1. 网格卡片视图 (Grid) -->
        <div
          v-else-if="viewMode === 'grid'"
          class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3"
        >
          <div
            v-for="cmd in displayedCommands"
            :key="cmd.id"
            draggable="true"
            @dragstart="handleDragStart(cmd, $event)"
            class="group relative flex flex-col justify-between p-3.5 rounded-xl border border-border/70 bg-card hover:border-primary/50 hover:shadow-md transition-all duration-200 select-none cursor-pointer"
            :style="getEffectiveCommandCardStyle(cmd)"
            @click="openEditCommandModal(cmd)"
          >
            <!-- 头部：图标、名称与所属文件夹 -->
            <div>
              <div class="flex items-start justify-between gap-2 mb-2">
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                    <i class="fas fa-terminal text-xs"></i>
                  </div>
                  <h4 class="text-xs font-semibold text-foreground truncate">
                    {{ cmd.name || cmd.command }}
                  </h4>
                </div>
                <!-- 单项移至文件夹下拉菜单触发器 -->
                <div class="relative" @click.stop>
                  <button
                    type="button"
                    @click.stop="activeMoveMenuCmdId = activeMoveMenuCmdId === cmd.id ? null : cmd.id"
                    class="p-1 rounded-md text-text-secondary hover:text-foreground hover:bg-muted text-xs transition-colors cursor-pointer"
                    :title="t('folders.moveToFolder', '移至文件夹')"
                  >
                    <i class="fas fa-folder-tree text-[11px] text-amber-400"></i>
                  </button>
                  <!-- 弹出层 -->
                  <div
                    v-if="activeMoveMenuCmdId === cmd.id"
                    class="absolute right-0 top-full mt-1 bg-popover border border-border shadow-xl rounded-xl py-1 z-50 min-w-[140px] max-h-48 overflow-y-auto"
                    @click.stop
                  >
                    <div
                      @click="handleMoveCommandToFolder(cmd, null)"
                      class="px-2.5 py-1.5 text-xs text-text-secondary hover:bg-muted hover:text-foreground cursor-pointer flex items-center gap-2"
                    >
                      <i class="fas fa-inbox text-xs"></i>
                      <span>{{ t('folders.uncategorized', '未分类') }}</span>
                    </div>
                    <div v-if="quickCommandTagsStore.folders.length > 0" class="h-px bg-border/40 my-0.5"></div>
                    <div
                      v-for="f in quickCommandTagsStore.folders"
                      :key="f.id"
                      @click="handleMoveCommandToFolder(cmd, f.id)"
                      class="px-2.5 py-1.5 text-xs text-foreground hover:bg-muted cursor-pointer flex items-center gap-2 truncate"
                    >
                      <span
                        v-if="f.background_color"
                        class="w-2 h-2 rounded-full flex-shrink-0"
                        :style="{ backgroundColor: f.background_color }"
                      ></span>
                      <i v-else class="fas fa-folder text-amber-400 text-xs"></i>
                      <span class="truncate">{{ f.name }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 指令预览代码框 -->
              <div class="px-2.5 py-1.5 rounded-lg bg-input/40 border border-border/40 font-mono text-[11px] text-text-secondary group-hover:text-foreground break-all line-clamp-2 leading-relaxed mb-3">
                {{ cmd.command }}
              </div>
            </div>

            <!-- 卡片底栏：快捷操作 -->
            <div class="flex items-center justify-between pt-2 border-t border-border/40 mt-auto" @click.stop>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  @click.stop="copyCommandText(cmd.command)"
                  class="p-1.5 rounded-md text-text-secondary hover:text-primary hover:bg-primary/10 transition-colors text-xs cursor-pointer"
                  :title="t('commandHistory.copy', '复制')"
                >
                  <i class="fas fa-copy"></i>
                </button>
                <button
                  type="button"
                  @click.stop="openEditCommandModal(cmd)"
                  class="p-1.5 rounded-md text-text-secondary hover:text-primary hover:bg-primary/10 transition-colors text-xs cursor-pointer"
                  :title="t('common.edit', '编辑')"
                >
                  <i class="fas fa-edit"></i>
                </button>
                <button
                  type="button"
                  @click.stop="handleDeleteCommand(cmd)"
                  class="p-1.5 rounded-md text-text-secondary hover:text-error hover:bg-error/10 transition-colors text-xs cursor-pointer"
                  :title="t('common.delete', '删除')"
                >
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>

              <!-- 执行按钮 -->
              <button
                type="button"
                @click.stop="executeCommand(cmd)"
                class="px-2.5 py-1 rounded-lg bg-primary text-white hover:bg-primary-hover active:scale-95 text-xs font-medium transition-all flex items-center gap-1.5 shadow-xs cursor-pointer"
                :title="t('quickCommands.form.execute', '执行')"
              >
                <i class="fas fa-play text-[9px]"></i>
                <span>{{ t('quickCommands.form.execute', '执行') }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 2. 药丸流式视图 (Pills) -->
        <div v-else-if="viewMode === 'pills'" class="flex flex-wrap gap-2.5">
          <div
            v-for="cmd in displayedCommands"
            :key="cmd.id"
            draggable="true"
            @dragstart="handleDragStart(cmd, $event)"
            class="group inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/70 bg-card hover:border-primary/50 hover:shadow-xs transition-all duration-150 select-none cursor-pointer"
            :style="getEffectiveCommandCardStyle(cmd)"
            @click="openEditCommandModal(cmd)"
          >
            <i class="fas fa-bolt text-amber-500 text-xs"></i>
            <span class="text-xs font-medium text-foreground truncate max-w-[260px]">
              {{ cmd.name || cmd.command }}
            </span>
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-1" @click.stop>
              <button
                type="button"
                @click.stop="copyCommandText(cmd.command)"
                class="p-1 rounded text-text-secondary hover:text-primary transition-colors text-xs cursor-pointer"
                :title="t('commandHistory.copy', '复制')"
              >
                <i class="fas fa-copy"></i>
              </button>
              <button
                type="button"
                @click.stop="executeCommand(cmd)"
                class="p-1 rounded text-primary hover:text-white hover:bg-primary transition-colors text-xs cursor-pointer"
                :title="t('quickCommands.form.execute', '执行')"
              >
                <i class="fas fa-play text-[10px]"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- 3. 紧凑列表视图 (List) -->
        <div v-else class="space-y-1.5">
          <div
            v-for="cmd in displayedCommands"
            :key="cmd.id"
            draggable="true"
            @dragstart="handleDragStart(cmd, $event)"
            class="group flex items-center justify-between p-2.5 rounded-xl border border-border/60 bg-card hover:border-primary/50 transition-all duration-150 cursor-pointer"
            :style="getEffectiveCommandCardStyle(cmd)"
            @click="openEditCommandModal(cmd)"
          >
            <div class="flex items-center gap-3 min-w-0 flex-1 mr-3">
              <div class="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                <i class="fas fa-terminal text-[10px]"></i>
              </div>
              <div class="flex flex-col min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-semibold text-foreground truncate">
                    {{ cmd.name || cmd.command }}
                  </span>
                  <span v-if="getCommandFolderName(cmd)" class="text-[10px] px-1.5 py-0.2 rounded bg-muted text-text-secondary font-medium truncate max-w-[120px]">
                    {{ getCommandFolderName(cmd) }}
                  </span>
                </div>
                <span class="text-[11px] font-mono text-text-secondary truncate">
                  {{ cmd.command }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-1.5 flex-shrink-0" @click.stop>
              <button
                type="button"
                @click.stop="copyCommandText(cmd.command)"
                class="p-1.5 rounded-md text-text-secondary hover:text-primary hover:bg-primary/10 transition-colors text-xs cursor-pointer"
                :title="t('commandHistory.copy', '复制')"
              >
                <i class="fas fa-copy"></i>
              </button>
              <button
                type="button"
                @click.stop="openEditCommandModal(cmd)"
                class="p-1.5 rounded-md text-text-secondary hover:text-primary hover:bg-primary/10 transition-colors text-xs cursor-pointer"
                :title="t('common.edit', '编辑')"
              >
                <i class="fas fa-edit"></i>
              </button>
              <button
                type="button"
                @click.stop="handleDeleteCommand(cmd)"
                class="p-1.5 rounded-md text-text-secondary hover:text-error hover:bg-error/10 transition-colors text-xs cursor-pointer"
                :title="t('common.delete', '删除')"
              >
                <i class="fas fa-trash-alt"></i>
              </button>
              <button
                type="button"
                @click.stop="executeCommand(cmd)"
                class="ml-1 px-2.5 py-1 rounded-lg bg-primary text-white hover:bg-primary-hover active:scale-95 text-xs font-medium transition-all flex items-center gap-1 shadow-xs cursor-pointer"
                :title="t('quickCommands.form.execute', '执行')"
              >
                <i class="fas fa-play text-[9px]"></i>
                <span>{{ t('quickCommands.form.execute', '执行') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 新建/编辑快捷指令模态框 -->
    <AddEditQuickCommandForm
      v-if="showAddEditModal"
      :command-to-edit="commandToEdit"
      @close="closeAddEditModal"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuickCommandsStore, type QuickCommandFE } from '../stores/quickCommands.store';
import { useQuickCommandTagsStore, type QuickCommandTag } from '../stores/quickCommandTags.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useSessionStore } from '../stores/session.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { resolveEffectiveColor, getItemColoredCardStyle } from '../utils/colorUtils';
import ColorPickerPopover from '../components/common/ColorPickerPopover.vue';
import AddEditQuickCommandForm from '../components/AddEditQuickCommandForm.vue';

const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const quickCommandsStore = useQuickCommandsStore();
const quickCommandTagsStore = useQuickCommandTagsStore();
const uiNotificationsStore = useUiNotificationsStore();
const sessionStore = useSessionStore();
const emitWorkspaceEvent = useWorkspaceEventEmitter();

// 当前选中的文件夹：'all' | 'uncategorized' | number
type ActiveFolderType = 'all' | 'uncategorized' | number;
const activeFolder = ref<ActiveFolderType>('all');
const searchQuery = ref('');

// 视图模式：'grid' | 'pills' | 'list'
type ViewModeType = 'grid' | 'pills' | 'list';
const viewMode = ref<ViewModeType>('grid');

// 排序模式：'name' | 'usage_count' | 'last_used'
type SortMode = 'name' | 'usage_count' | 'last_used';
const currentSort = ref<SortMode>('name');

// 模态框与单项操作状态
const showAddEditModal = ref(false);
const commandToEdit = ref<QuickCommandFE | null>(null);
const activeMoveMenuCmdId = ref<number | null>(null);

// 文件夹重命名与新建状态
const isCreatingFolder = ref(false);
const newFolderName = ref('');
const newFolderInputRef = ref<HTMLInputElement | null>(null);

const editingFolderId = ref<number | null>(null);
const editingFolderName = ref('');
const editFolderInputRef = ref<HTMLInputElement | null>(null);

// 拖拽状态
const draggedCmdId = ref<number | null>(null);
const dragOverFolderId = ref<ActiveFolderType | null>(null);

onMounted(async () => {
  await Promise.all([
    quickCommandsStore.fetchQuickCommands(),
    quickCommandTagsStore.fetchTags(),
  ]);
});

// 计算属性：全部指令与未分类指令计数
const allCommandsCount = computed(() => quickCommandsStore.quickCommandsList.length);
const uncategorizedCommandsCount = computed(() => {
  return quickCommandsStore.quickCommandsList.filter(cmd => !cmd.tagIds || cmd.tagIds.length === 0).length;
});

const getFolderCommandsCount = (tagId: number): number => {
  return quickCommandsStore.quickCommandsList.filter(cmd => cmd.tagIds && cmd.tagIds.includes(tagId)).length;
};

const getCommandFolderName = (cmd: QuickCommandFE): string | null => {
  if (!cmd.tagIds || cmd.tagIds.length === 0) return null;
  const folder = quickCommandTagsStore.folders.find(f => f.id === cmd.tagIds![0]);
  return folder ? folder.name : null;
};

// 当前文件夹标题
const activeFolderTitle = computed(() => {
  if (activeFolder.value === 'all') return t('folders.allCommands', '全部指令');
  if (activeFolder.value === 'uncategorized') return t('folders.uncategorized', '未分类');
  const folder = quickCommandTagsStore.folders.find(f => f.id === activeFolder.value);
  return folder ? folder.name : t('folders.title', '文件夹');
});

// 过滤与排序后的显示指令列表
const displayedCommands = computed(() => {
  let list = [...quickCommandsStore.quickCommandsList];

  // 1. 文件夹筛选
  if (activeFolder.value === 'uncategorized') {
    list = list.filter(cmd => !cmd.tagIds || cmd.tagIds.length === 0);
  } else if (typeof activeFolder.value === 'number') {
    const fid = activeFolder.value;
    list = list.filter(cmd => cmd.tagIds && cmd.tagIds.includes(fid));
  }

  // 2. 搜索关键词筛选
  const query = searchQuery.value.trim().toLowerCase();
  if (query) {
    list = list.filter(cmd => {
      const nameMatch = cmd.name ? cmd.name.toLowerCase().includes(query) : false;
      const cmdMatch = cmd.command.toLowerCase().includes(query);
      return nameMatch || cmdMatch;
    });
  }

  // 3. 排序
  list.sort((a, b) => {
    if (currentSort.value === 'usage_count') {
      const countA = a.usage_count || 0;
      const countB = b.usage_count || 0;
      if (countB !== countA) return countB - countA;
    } else if (currentSort.value === 'last_used') {
      const timeA = a.updated_at || 0;
      const timeB = b.updated_at || 0;
      if (timeB !== timeA) return timeB - timeA;
    }
    const nameA = a.name || a.command;
    const nameB = b.name || b.command;
    return nameA.localeCompare(nameB);
  });

  return list;
});

// 计算卡片继承背景色样式
const getEffectiveCommandCardStyle = (cmd: QuickCommandFE) => {
  let folderColor: string | null = null;
  if (cmd.tagIds && cmd.tagIds.length > 0) {
    const folder = quickCommandTagsStore.folders.find(f => f.id === cmd.tagIds![0]);
    folderColor = folder?.background_color || null;
  }
  const effectiveColor = resolveEffectiveColor(cmd.background_color, folderColor);
  if (!effectiveColor) return {};
  return getItemColoredCardStyle(effectiveColor, { alpha: 0.14, borderAlpha: 0.35 });
};

// 排序切换与文案
const toggleSortBy = () => {
  if (currentSort.value === 'name') currentSort.value = 'usage_count';
  else if (currentSort.value === 'usage_count') currentSort.value = 'last_used';
  else currentSort.value = 'name';
};

const sortButtonTitle = computed(() => {
  if (currentSort.value === 'usage_count') return t('quickCommands.sort.usageCount', '按使用频率排序');
  if (currentSort.value === 'last_used') return t('quickCommands.sort.lastUsed', '按更新时间排序');
  return t('quickCommands.sort.name', '按名称字母排序');
});

const sortButtonIcon = computed(() => {
  if (currentSort.value === 'usage_count') return 'fas fa-fire text-amber-500';
  if (currentSort.value === 'last_used') return 'fas fa-clock text-blue-500';
  return 'fas fa-sort-alpha-down text-primary';
});

const sortButtonText = computed(() => {
  if (currentSort.value === 'usage_count') return t('quickCommands.sort.usageCountShort', '按频率');
  if (currentSort.value === 'last_used') return t('quickCommands.sort.lastUsedShort', '按时间');
  return t('quickCommands.sort.nameShort', '按名称');
});

// 文件夹新建
const startCreatingFolder = () => {
  isCreatingFolder.value = true;
  newFolderName.value = '';
  nextTick(() => {
    newFolderInputRef.value?.focus();
  });
};

const handleCreateFolderConfirm = async () => {
  const name = newFolderName.value.trim();
  if (!name) {
    isCreatingFolder.value = false;
    return;
  }
  const created = await quickCommandTagsStore.createFolder(name);
  if (created) {
    uiNotificationsStore.showSuccess(t('folders.createdSuccess', '文件夹已创建'));
    activeFolder.value = created.id;
  }
  isCreatingFolder.value = false;
  newFolderName.value = '';
};

// 文件夹重命名
const handleStartRenameFolder = (folder: QuickCommandTag) => {
  editingFolderId.value = folder.id;
  editingFolderName.value = folder.name;
  nextTick(() => {
    editFolderInputRef.value?.focus();
  });
};

const handleFinishRenameFolder = async () => {
  if (editingFolderId.value === null) return;
  const fid = editingFolderId.value;
  const newName = editingFolderName.value.trim();
  editingFolderId.value = null;
  if (!newName) return;

  const success = await quickCommandTagsStore.renameFolder(fid, newName);
  if (success) {
    uiNotificationsStore.showSuccess(t('folders.renamedSuccess', '文件夹已重命名'));
  }
};

// 文件夹删除
const handleDeleteFolder = async (folder: QuickCommandTag) => {
  const confirmed = await showConfirmDialog({
    message: t('folders.deleteConfirm', { name: folder.name }, `确定要删除文件夹 "${folder.name}" 吗？里面的指令将变为未分类。`)
  });
  if (confirmed) {
    const success = await quickCommandTagsStore.deleteFolder(folder.id);
    if (success) {
      uiNotificationsStore.showSuccess(t('folders.deletedSuccess', '文件夹已删除'));
      if (activeFolder.value === folder.id) {
        activeFolder.value = 'all';
      }
    }
  }
};

// 调色板浮层状态
const activeColorPickerFolderId = ref<number | null>(null);
const activeColorPickerTriggerEl = ref<HTMLElement | null>(null);

// 文件夹调色板
const toggleFolderColorPicker = (folderId: number, e: Event) => {
  e.stopPropagation();
  if (activeColorPickerFolderId.value === folderId) {
    activeColorPickerFolderId.value = null;
    activeColorPickerTriggerEl.value = null;
  } else {
    activeColorPickerFolderId.value = folderId;
    activeColorPickerTriggerEl.value = (e.currentTarget as HTMLElement) || (e.target as HTMLElement);
  }
};

const handleSaveFolderColor = async (folderId: number, color: string | null) => {
  await quickCommandTagsStore.updateFolderColor(folderId, color);
  uiNotificationsStore.showSuccess(t('folders.colorUpdated', '文件夹背景颜色已更新'));
  activeColorPickerFolderId.value = null;
  activeColorPickerTriggerEl.value = null;
};

// 拖拽与移动到文件夹
const handleDragStart = (cmd: QuickCommandFE, event: DragEvent) => {
  draggedCmdId.value = cmd.id;
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', String(cmd.id));
    event.dataTransfer.effectAllowed = 'move';
  }
};

const handleDropOnFolder = async (targetFolder: ActiveFolderType) => {
  if (!draggedCmdId.value) return;
  const cmd = quickCommandsStore.quickCommandsList.find(c => c.id === draggedCmdId.value);
  dragOverFolderId.value = null;
  const currentDragId = draggedCmdId.value;
  draggedCmdId.value = null;
  if (!cmd) return;

  const folderId = typeof targetFolder === 'number' ? targetFolder : null;
  await handleMoveCommandToFolder(cmd, folderId);
};

const handleMoveCommandToFolder = async (cmd: QuickCommandFE, targetFolderId: number | null) => {
  activeMoveMenuCmdId.value = null;
  const success = await quickCommandsStore.moveCommandToFolder(cmd.id, targetFolderId);
  if (success) {
    uiNotificationsStore.showSuccess(t('folders.moveSuccess', '已移动至目标文件夹'));
  }
};

// 指令操作：新建、编辑、删除、复制、执行
const openAddCommandModal = () => {
  commandToEdit.value = null;
  showAddEditModal.value = true;
};

const openEditCommandModal = (cmd: QuickCommandFE) => {
  commandToEdit.value = cmd;
  showAddEditModal.value = true;
};

const closeAddEditModal = () => {
  showAddEditModal.value = false;
  commandToEdit.value = null;
};

const copyCommandText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    uiNotificationsStore.showSuccess(t('commandHistory.copied', '已复制到剪贴板'));
  } catch (_) {
    uiNotificationsStore.showError(t('commandHistory.copyFailed', '复制失败'));
  }
};

const handleDeleteCommand = async (cmd: QuickCommandFE) => {
  const confirmed = await showConfirmDialog({
    message: t('quickCommands.deleteConfirm', { name: cmd.name || cmd.command }, `确定要删除指令 "${cmd.name || cmd.command}" 吗？`)
  });
  if (confirmed) {
    await quickCommandsStore.deleteQuickCommand(cmd.id);
  }
};

const executeCommand = (cmd: QuickCommandFE) => {
  const activeSessionId = sessionStore.activeSessionId;
  if (!activeSessionId) {
    uiNotificationsStore.showWarning(t('quickCommands.noActiveSession', '当前没有活动终端会话，请先在终端工作区打开连接'));
    return;
  }
  emitWorkspaceEvent('quickCommand:executeProcessed', {
    command: cmd.command,
    sessionId: activeSessionId
  });
  uiNotificationsStore.showSuccess(t('quickCommands.executed', '指令已发送执行'));
};
</script>
