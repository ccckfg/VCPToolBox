class FriendBook {
    constructor(options = {}) {
        this.callOneBot = options.callOneBot;
        this.log = options.log || (() => { });
        this.friends = new Map();
        this.nameIndex = new Map();
        this._refreshTimer = null;
    }

    async refresh() {
        try {
            const res = await this.callOneBot('get_friend_list');
            const list = res.data || [];
            this.friends.clear();
            this.nameIndex.clear();

            for (const f of list) {
                const uid = String(f.user_id);
                const nickname = f.nickname || '';
                const remark = f.remark || '';

                this.friends.set(uid, { nickname, remark, user_id: f.user_id });
                if (remark) this.nameIndex.set(remark.toLowerCase(), uid);
                if (nickname) this.nameIndex.set(nickname.toLowerCase(), uid);
                this.nameIndex.set(uid, uid);
            }

            this.log('INFO', `[好友通讯录] 已加载 ${this.friends.size} 个好友`);
        } catch (err) {
            this.log('ERROR', '[好友通讯录] 拉取好友列表失败:', err.message);
        }
    }

    resolve(nameOrId) {
        if (!nameOrId) return null;
        const key = String(nameOrId).toLowerCase();
        return this.nameIndex.get(key) || null;
    }

    getInfo(userId) {
        return this.friends.get(String(userId)) || null;
    }

    toList() {
        const result = [];
        for (const [uid, info] of this.friends) {
            result.push({ user_id: Number(uid), nickname: info.nickname, remark: info.remark });
        }
        return result;
    }

    startAutoRefresh(intervalMs = 30 * 60 * 1000) {
        if (this._refreshTimer) clearInterval(this._refreshTimer);
        this._refreshTimer = setInterval(() => this.refresh(), intervalMs);
        if (this._refreshTimer.unref) this._refreshTimer.unref();
    }

    stop() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }
}

module.exports = {
    FriendBook
};
