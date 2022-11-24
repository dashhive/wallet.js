(function (exports) {
  "use strict";

  let Wallet = {};
  //@ts-ignore
  exports.Wallet = Wallet;

  let HdKey = require("hdkey");
  let Bip39 = require("bip39");
  //let Passphrase = require("@root/passphrase");
  let DashApi = require("./dashapi.js");

  /** @typedef {import('dashsight').CoreUtxo} CoreUtxo */
  /** @typedef {import('dashsight').GetTxs} GetTxs */
  /** @typedef {import('dashsight').GetUtxos} GetUtxos */
  /** @typedef {import('dashsight').InstantSend} InstantSend */
  /** @typedef {import('dashsight').InsightUtxo} InsightUtxo */

  //@ts-ignore
  let Dashcore = exports.dashcore || require("./lib/dashcore.js");
  let Transaction = Dashcore.Transaction;

  /**
   * Like CoreUtxo, but only the parts we need for a transaction
   * @typedef MiniUtxo
   * @property {String} txId
   * @property {Number} outputIndex - a.k.a. vout index
   * @property {String} [address] - coined pubKeyHash
   * @property {String} script - hex
   * @property {Number} satoshis
   */

  /**
   * @typedef WalletAddress
   * @prop {Number} checked_at
   * @prop {String} hdpath - hdkey path (ex: "m/44'/5'/0'/0")
   * @prop {Number} index - hdkey path index
   * @prop {Array<[Number, String]>} txs - tx.time and tx.txid
   * @prop {Array<MiniUtxo>} utxos
   * @prop {String} wallet - name of wallet (not a true id)
   */

  //@ts-ignore
  let b58c = exports.DashCheck || require("./lib/dashcheck.js");

  /**
   * @typedef Config
   * @prop {Safe} safe
   * @prop {Store} store
   * @prop {Wallet} main
   * @prop {DashSightPartial} dashsight
   */

  /**
   * @typedef DashSightPartial
   * @prop {InstantSend} instantSend
   * @prop {GetTxs} getTxs
   * @prop {GetUtxos} getUtxos
   */

  /**
   * @typedef Store
   * @prop {StoreSave} save
   *
   * @callback StoreSave
   * @param { Cache|
   *    Object.<String,PayWallet>|
   *    Preferences|
   *    Object.<String,PrivateWallet> } data
   */

  /**
   * @typedef WalletInstance
   * @prop {Befriend} befriend
   * @prop {Sync} sync
   */

  /**
   * @callback Sync
   * @param {SyncOpts} opts
   *
   * @typedef SyncOpts
   * @prop {Number} now - value to be used for 'checked_at'
   * @prop {Number} [staletime] - default 60_000 ms, set to 0 to force checking
   */

  /**
   * Add or generate and return (mutual) xpub key(s) for a contact
   * @callback Befriend
   * @param {BefriendOpts} opts
   * @returns {Promise<[String, PayWallet]>} - rxXPub, txXPub, txStaticAddr
   *
   * @typedef BefriendOpts
   * @prop {String} handle
   * @prop {String} xpub - receive-only xpub key from friend
   * @prop {String} addr - reusable address, e.g. for Coinbase
   */

  /**
   * Find a friend's xpub key
   * @callback FindPayWallets
   * @param {FindFriendOpts} opts
   * @returns {Array<PayWallet>} - wallets matching this friend
   *
   * @typedef FindFriendOpts
   * @prop {String} handle
   */

  /**
   * Find a private wallet by handle
   * @callback FindPrivateWallets
   * @param {FindFriendOpts} opts
   * @returns {Array<PrivateWallet>} - wallets matching this friend
   */

  /**
   * @typedef Safe
   * @prop {Object<String, PrivateWallet>} privateWallets
   * @prop {Object<String, PayWallet>} payWallets
   * @prop {Preferences} preferences
   * @prop {Cache} cache
   *
   * @typedef {Object.<String, unknown>} Preferences
   *
   * TODO txs and wifs?
   * @typedef Cache
   * @prop {Object<String, Wallet>} addresses
   */

  /**
   * @typedef PrivateWallet
   * @prop {String?} contact
   * @prop {String?} device
   * @prop {String} label
   * @prop {Array<String>} mnemonic
   * @prop {String} name
   * @prop {Number} priority
   * @prop {String} created_at - ISO Date
   * @prop {String?} archived_at - ISO Date
   */

  /**
   * @typedef PayWallet
   * @prop {String?} contact
   * @prop {String?} device
   * @prop {String} label
   * @prop {String} name
   * @prop {Number} priority
   * @prop {String} addr - instead of xpub, e.g. for coinbase
   * @prop {String} xpub
   * @prop {String} created_at - ISO Date
   * @prop {String?} archived_at - ISO Date
   */

  Wallet.toDuff = DashApi.toDuff;
  Wallet.DashTypes = DashApi.DashTypes;
  Wallet.DUFFS = DashApi.DUFFS;

  /**
   * @param {Config} config
   * @returns {Promise<WalletInstance>}
   */
  Wallet.create = async function (config) {
    let safe = config.safe;
    let wallet = {};
    let dashsight = config.dashsight;

    // TODO rename addContactByXPub, addContactByAddr?
    /** @type Befriend */
    wallet.befriend = async function ({ handle, xpub, addr }) {
      if (!handle) {
        throw new Error(`no 'handle' given`);
      }

      let safe = config.safe;

      /** @type {PayWallet} */
      let txWallet;
      let hasAddr = xpub || addr;
      if (hasAddr) {
        txWallet = _getPayWallet(handle, xpub, addr);
        // most recently added will sort first;
        txWallet.priority = Date.now();
        await config.store.save(safe.payWallets);
      } else {
        let txws = await wallet.findPayWallets({ handle });
        txWallet = txws[0];
      }

      /** @type {PrivateWallet} */
      let rxWallet;
      /** @type {Array<PrivateWallet>} */
      let rxws = Object.values(safe.privateWallets)
        .filter(function (wallet) {
          return wallet.contact === handle;
        })
        .sort(wallet._sort);
      if (!rxws.length) {
        // TODO use main wallet as seed
        rxWallet = Wallet.generate({
          name: handle,
          label: handle,
          priority: Date.now(),
          contact: handle,
        });

        for (let i = 1; ; i += 1) {
          if (!safe.privateWallets[`${handle}:${i}`]) {
            safe.privateWallets[`${handle}:${i}`] = rxWallet;
            break;
          }
        }
        await config.store.save(safe.privateWallets);

        rxws.push(rxWallet);
      }
      rxWallet = rxws[0];

      // TODO use derivation from main for non-imported wallets
      let seed = await Bip39.mnemonicToSeed(rxWallet.mnemonic.join(" "));
      let privateRoot = HdKey.fromMasterSeed(seed);
      // The full path looks like `m/44'/5'/0'/0/0`
      // We "harden" the prefix `m/44'/5'/0'/0`
      let account = 0;
      let direction = 0;
      let derivationPath = `m/44'/${DashApi.DashTypes.coinType}'/${account}'/${direction}`;
      let publicParentExtendedKey =
        privateRoot.derive(derivationPath).publicExtendedKey;
      return [publicParentExtendedKey, txWallet];
    };

    /**
     * @param {String} handle - contact's handle
     * @param {String} xpub
     * @param {String} addr
     * @returns {PayWallet}
     */
    function _getPayWallet(handle, xpub, addr) {
      if (xpub) {
        Wallet.assertXPub(xpub);
      }

      let txWallet = Object.values(safe.payWallets)
        .sort(wallet._sort)
        .find(function (wallet) {
          if (wallet.contact !== handle) {
            return false;
          }

          if (xpub.length > 0) {
            return xpub === wallet.xpub;
          }

          if (addr.length > 0) {
            return addr === wallet.addr;
          }

          return false;
        });
      if (!txWallet) {
        txWallet = Wallet.generatePayWallet({
          handle: handle,
          xpub: xpub,
          addr: addr,
        });
        for (let i = 1; ; i += 1) {
          if (!safe.payWallets[`${handle}:${i}`]) {
            safe.payWallets[`${handle}:${i}`] = txWallet;
            break;
          }
        }
      }
      return txWallet;
    }

    /**
     * Show balances of addresses for which we have the private keys (WIF)
     * (don't forget to sync first!)
     * @returns {Promise<Object.<String, Number>>}
     */
    wallet.balances = async function () {
      /** @type {Object.<String, Number>} */
      let balances = {};

      Object.values(safe.cache.addresses).forEach(function (addr) {
        if (!addr.hdpath) {
          return;
        }

        let b = addr.utxos.reduce(
          /**
           * @param {Number} satoshis
           * @param {InsightUtxo} utxo
           */
          function (satoshis, utxo) {
            return utxo.satoshis + satoshis;
          },
          0,
        );

        if (!balances[addr.wallet]) {
          balances[addr.wallet] = 0;
        }
        balances[addr.wallet] += b;
      });

      return balances;
    };

    /**
     * @returns {Promise<Array<CoreUtxo>>}
     */
    wallet.utxos = async function () {
      /** @type {Array<Required<MiniUtxo>>} */
      let utxos = [];

      Object.keys(safe.cache.addresses).forEach(function (addr) {
        let addrInfo = safe.cache.addresses[addr];
        if (!addrInfo.hdpath) {
          return;
        }
        addrInfo.utxos.forEach(
          /** @param {MiniUtxo} utxo */
          function (utxo) {
            let _utxo = Object.assign({ address: addr }, utxo);
            utxos.push(_utxo);
          },
        );
      });

      return utxos;
    };

    /** @type {FindPayWallets} */
    wallet.findPayWallets = async function ({ handle }) {
      // TODO filter out archived wallets?
      let txws = Object.values(safe.payWallets)
        .filter(function (wallet) {
          return wallet.contact === handle;
        })
        .sort(wallet._sort);
      return txws;
    };

    /**
     * @param {PayWallet|PrivateWallet} a
     * @param {PayWallet|PrivateWallet} b
     */
    wallet._sort = function (a, b) {
      return b.priority - a.priority;
    };

    /** @type {FindPrivateWallets } */
    wallet.findPrivateWallets = async function ({ handle }) {
      // TODO filter out archived wallets?
      let txws = Object.values(safe.privateWallets)
        .filter(function (wallet) {
          return wallet.contact === handle;
        })
        .sort(wallet._sort);
      return txws;
    };

    /**
     * @param {Object} opts
     * @param {String} opts.handle - a private wallet name
     * @param {Number} opts.direction - 0 for deposit, 1 for change
     * @returns {Promise<String>} - pay address
     */
    wallet._nextWalletAddr = async function ({ handle, direction }) {
      let ws = await wallet.findPrivateWallets({ handle });
      let w = ws[0] || safe.privateWallets.main;

      let mnemonic = w.mnemonic.join(" ");
      let seed = await Bip39.mnemonicToSeed(mnemonic);
      let privateRoot = HdKey.fromMasterSeed(seed);

      let account = 0; // main
      let hdpath = `m/44'/${DashApi.DashTypes.coinType}'/${account}'/${direction}`;

      let derivedRoot = privateRoot.derive(hdpath);

      let now = Date.now();
      let nextIndex = await indexPayAddrs(w.name, derivedRoot, hdpath, now);
      await config.store.save(safe.cache);

      return await wallet._getAddr({ derivedRoot, index: nextIndex });
    };

    /**
     * @param {Object} opts
     * @param {String} opts.handle
     */
    wallet.createNextPayAddr = async function ({ handle }) {
      let ws = await wallet.findPayWallets({ handle });
      let payWallet = ws[0];

      if (payWallet.addr) {
        return {
          addr: payWallet.addr,
          index: null,
        };
      }

      let derivedRoot = HdKey.fromExtendedKey(payWallet.xpub);

      let now = Date.now();
      let nextIndex = await indexPayAddrs(payWallet.name, derivedRoot, "", now);
      await config.store.save(safe.cache);

      let addr = await wallet._getAddr({ derivedRoot, index: nextIndex });
      return {
        addr,
        index: nextIndex,
      };
    };

    /**
     * @param {Object} opts
     * @param {import('hdkey')} opts.derivedRoot
     * @param {Number} opts.index
     * @returns {Promise<String>} - next pay addr
     */
    wallet._getAddr = async function ({ derivedRoot, index }) {
      //@ts-ignore - tsc bug
      let derivedChild = derivedRoot.deriveChild(index);

      let nextPayAddr = await b58c.encode({
        version: DashApi.DashTypes.pubKeyHashVersion,
        pubKeyHash: derivedChild.pubKeyHash.toString("hex"),
        compressed: true,
      });

      return nextPayAddr;
    };

    /**
     * Send with change back to main wallet
     * @param {Object} opts
     * @param {String} opts.handle
     * @param {Number} opts.amount - duffs/satoshis
     */
    wallet.pay = async function ({ handle, amount }) {
      let txHex = await wallet.createTx({ handle, amount });

      let result = await dashsight.instantSend(txHex).catch(
        /** @param {Error} err */
        function (err) {
          //@ts-ignore
          err.failedTx = txHex;
          throw err;
        },
      );
      return result;
    };

    /**
     * @param {Object} opts
     * @param {String} opts.handle
     * @param {Number} opts.amount - duffs/satoshis
     */
    wallet.createTx = async function ({ handle, amount }) {
      let nextPayAddr = "";
      let isPayAddr = _isPayAddr(handle);
      if (isPayAddr) {
        nextPayAddr = handle;
      }

      {
        let payWallets = await wallet.findPayWallets({ handle });
        let payWallet = payWallets[0];
        if (!payWallet) {
          throw new Error(`no pay-to wallet found for '${handle}'`);
        }

        nextPayAddr = payWallet.addr;
        if (!nextPayAddr) {
          let now = Date.now();
          let derivedRoot = HdKey.fromExtendedKey(payWallet.xpub);
          let nextIndex = await indexPayAddrs(
            payWallet.name,
            derivedRoot,
            "",
            now,
          );
          await config.store.save(safe.cache);

          //@ts-ignore - tsc bug
          let derivedChild = derivedRoot.deriveChild(nextIndex);
          nextPayAddr = await b58c.encode({
            version: DashApi.DashTypes.pubKeyHashVersion,
            pubKeyHash: derivedChild.pubKeyHash.toString("hex"),
            compressed: true,
          });
        }
      }

      let allUtxos = await wallet.utxos();

      // TODO make more accurate? How many bytes per additional utxo? signature?
      let feePreEstimate = 1000;
      //let insightUtxos = await dashsight.getUtxos(utxoAddr);
      //let allUtxos = await DashApi.getUtxos(insightUtxos);
      let utxos = await DashApi.getOptimalUtxos(
        allUtxos,
        amount + feePreEstimate,
      );
      let balance = DashApi.getBalance(utxos);

      if (!utxos.length) {
        let totalBalance = DashApi.getBalance(allUtxos);
        let dashBalance = DashApi.toDash(totalBalance);
        let dashAmount = DashApi.toDash(amount);
        throw new Error(
          `insufficient funds: cannot pay ${dashAmount} (+fees) with ${dashBalance}`,
        );
      }

      let wifs = await wallet._utxosToWifs(utxos);
      if (!wifs.length) {
        throw new Error(
          `could not find private keys corresponding to chosen utxos`,
        );
      }

      // (estimate) don't send dust back as change
      if (balance - amount <= DashApi.DUST + DashApi.FEE) {
        amount = balance;
      }

      //@ts-ignore - no input required, actually
      let tmpTx = new Transaction()
        //@ts-ignore - allows single value or array
        .from(utxos);
      tmpTx.to(nextPayAddr, amount);
      //@ts-ignore - the JSDoc is wrong in dashcore-lib/lib/transaction/transaction.js
      let changeAddr = await wallet._nextWalletAddr({ handle, direction: 1 });
      await config.store.save(safe.cache);
      tmpTx.change(changeAddr);
      tmpTx.sign(wifs);

      // TODO getsmartfeeestimate??
      // fee = 1duff/byte (2 chars hex is 1 byte)
      //       +10 to be safe (the tmpTx may be a few bytes off - probably only 4 -
      //       due to how small numbers are encoded)
      let fee = 10 + tmpTx.toString().length / 2;

      // (adjusted) don't send dust back as change
      if (balance + -amount + -fee <= DashApi.DUST) {
        amount = balance - fee;
      }

      //@ts-ignore - no input required, actually
      let tx = new Transaction()
        //@ts-ignore - allows single value or array
        .from(utxos);
      tx.to(nextPayAddr, amount);
      tx.fee(fee);
      //@ts-ignore - see above
      tx.change(changeAddr);
      tx.sign(wifs);

      let txHex = tx.serialize();
      return txHex;
    };

    /**
     * @param {String} addr
     * @returns {Boolean}
     */
    function _isPayAddr(addr) {
      if (34 !== addr?.length) {
        return false;
      }

      if (!["X", "Y"].includes(addr[0])) {
        return false;
      }

      return true;
    }

    /**
     * @param {Array<CoreUtxo>} utxos
     * @returns {Promise<Array<String>>} - wifs
     */
    wallet._utxosToWifs = async function (utxos) {
      /** @type {Object.<String, Boolean>} */
      let wifs = {};

      await utxos.reduce(async function (promise, utxo) {
        await promise;

        let wif = await wallet._toWif(utxo.address);
        wifs[wif] = true;
      }, Promise.resolve());

      let wifkeys = Object.keys(wifs);
      return wifkeys;
    };

    /**
     * @param {String} addr - pay address
     * @returns {Promise<String>} - wif (private key)
     */
    wallet._toWif = async function (addr) {
      let addrInfo = safe.cache.addresses[addr];
      if (!addrInfo) {
        throw new Error(`cannot find address info for '${addr}'`);
      }

      let w = Object.values(safe.privateWallets).find(function (wallet) {
        return wallet.name === addrInfo.wallet;
      });
      if (!w) {
        throw new Error(`cannot find wallet for '${addr}'`);
      }

      let mnemonic = w.mnemonic.join(" ");
      let seed = await Bip39.mnemonicToSeed(mnemonic);
      let privateRoot = HdKey.fromMasterSeed(seed);

      let derivedRoot = privateRoot.derive(addrInfo.hdpath);

      //@ts-ignore - tsc bug
      let derivedChild = derivedRoot.deriveChild(addrInfo.index);

      let address = await b58c.encode({
        version: DashApi.DashTypes.pubKeyHashVersion,
        pubKeyHash: derivedChild.pubKeyHash.toString("hex"),
        compressed: true,
      });
      if (address !== addr) {
        throw new Error(
          `check fail: hdpath '${addrInfo.hdpath}/${addrInfo.index}' for '${addr}' derived '${address}'`,
        );
      }
      let wif = await b58c.encode({
        version: DashApi.DashTypes.privateKeyVersion,
        pubKeyHash: derivedChild.privateKey.toString("hex"),
        compressed: true,
      });
      return wif;
    };

    // 1. Check cached addresses until finding 20 with no transactions
    // 2. Check 20 forward from last index for any transaction at all
    //    - If yes, check for balance
    //    - if it has txs and no balance, it's probably donezo
    // 3. Check empty (sparse) addresses for transactions
    // 4. For anything that has a balance, check again
    /**@type {Sync} */
    wallet.sync = async function ({ now, staletime = 60 * 1000 }) {
      await Object.values(safe.privateWallets).reduce(async function (
        promise,
        w,
      ) {
        await promise;

        let derivedRoot;

        let mnemonic = w.mnemonic.join(" ");
        // TODO use derivation from main for non-imported wallets
        let seed = await Bip39.mnemonicToSeed(mnemonic);
        let privateRoot = HdKey.fromMasterSeed(seed);
        // The full path looks like `m/44'/5'/0'/0/0`
        // We "harden" the prefix `m/44'/5'/0'/0`
        let account = 0;

        // rx addresses
        let direction = 0;
        let hdpath = `m/44'/${DashApi.DashTypes.coinType}'/${account}'/${direction}`;
        derivedRoot = privateRoot.derive(hdpath);
        await indexPayAddrs(w.name, derivedRoot, hdpath, now, staletime);

        // change addresses
        direction = 1;
        hdpath = `m/44'/${DashApi.DashTypes.coinType}'/${account}'/${direction}`;
        derivedRoot = privateRoot.derive(hdpath);
        await indexPayAddrs(w.name, derivedRoot, hdpath, now, staletime);

        await config.store.save(safe.privateWallets);
      },
      Promise.resolve());

      await config.store.save(safe.cache);
    };

    /**
     * TODO - rename because this updates the cache, not just 'check'
     * @param {String} walletName
     * @param {import('hdkey')} derivedRoot - TODO
     * @param {String} hdpath - derivation path
     * @param {Number} now
     * @prop {Number} [staletime] - default 60_000 ms, set to 0 to force checking
     * @returns {Promise<Number>} - the next, possibly sparse, unused address index
     */
    async function indexPayAddrs(
      walletName,
      derivedRoot,
      hdpath,
      now,
      staletime = 60 * 1000,
    ) {
      let MAX_SPARSE_UNCHECKED = 20;
      let MAX_SPARSE_CHECKED = 5;

      let recentlyUsedIndex = -1;
      let count = 0;
      for (let index = 0; ; index += 1) {
        //@ts-ignore
        let derivedChild = derivedRoot.deriveChild(index);
        let addr = await b58c.encode({
          version: DashApi.DashTypes.pubKeyHashVersion,
          pubKeyHash: derivedChild.pubKeyHash.toString("hex"),
          compressed: true,
        });
        let info = safe.cache.addresses[addr];
        if (info?.txs.length) {
          //console.log("[DEBUG] [used]", index);
          recentlyUsedIndex = index;
          count = 0;
        } else {
          //console.log("[DEBUG] possibly unused", index);
          count += 1;
        }
        if (count >= MAX_SPARSE_UNCHECKED) {
          // we've checked this wallet for the maximum consecutive unused
          // addresses from the last (possibly sparsely) used address
          break;
        }
      }
      //console.log("[DEBUG] recentlyUsedIndex", recentlyUsedIndex);

      count = 0;
      for (let index = recentlyUsedIndex; ; ) {
        index += 1;

        //@ts-ignore
        let derivedChild = derivedRoot.deriveChild(index);
        let addr = await b58c.encode({
          version: DashApi.DashTypes.pubKeyHashVersion,
          pubKeyHash: derivedChild.pubKeyHash.toString("hex"),
          compressed: true,
        });
        let info = safe.cache.addresses[addr];
        if (!info) {
          info = Wallet.generateAddress({
            wallet: walletName,
            hdpath: hdpath,
            index: index,
          });
          safe.cache.addresses[addr] = info;
        }

        let fresh = now - info.checked_at < staletime;
        if (!info.txs.length && !fresh) {
          let insightTxs = await dashsight.getTxs(addr, 1);
          let tx = insightTxs.txs[0];
          if (tx?.time) {
            //console.log(`[DEBUG] update ${index}: txs`);
            let txid = tx.txid;
            // TODO link utxos to txs
            info.txs.push([tx.time, txid]);
            // TODO second pass is to check utxos again
            info.utxos = await getMiniUtxos(addr);
          } else {
            //console.log(`[DEBUG] update ${index}: NO txs`);
          }
          info.checked_at = now;
        }
        // TODO also skip addresses that are known to be pending receiving a payment?
        if (info.txs.length) {
          recentlyUsedIndex = index;
          count = 0;
        } else {
          count += 1;
          if (count >= MAX_SPARSE_CHECKED) {
            // we've checked this wallet for the maximum consecutive unused
            // addresses from the last (possibly sparsely) used address
            break;
          }
        }
      }

      return recentlyUsedIndex + 1;
    }

    /**
     * @param {String} addr
     * @returns {Promise<Array<MiniUtxo>>}
     */
    async function getMiniUtxos(addr) {
      let insightUtxos = await dashsight.getUtxos(addr);
      let utxos = insightUtxos.map(function ({
        txid,
        vout,
        satoshis,
        scriptPubKey,
      }) {
        return {
          txId: txid,
          outputIndex: vout,
          //address: utxo.address,
          script: scriptPubKey,
          satoshis: satoshis,
        };
      });

      return utxos;
    }

    if (!safe.cache) {
      safe.cache = { addresses: {} };
    }
    if (!safe.cache.addresses) {
      safe.cache.addresses = {};
    }
    if (!safe.payWallets) {
      safe.payWallets = {};
    }
    if (!safe.preferences) {
      safe.preferences = {};
    }
    if (!safe.privateWallets) {
      safe.privateWallets = {};
    }
    if (!safe.privateWallets.main) {
      safe.privateWallets.main = Wallet.generate({
        name: "main",
        label: "Main",
        priority: 1,
      });
      await config.store.save(safe.privateWallets);
    }
    config.main = safe.privateWallets.main;

    return wallet;
  };

  /**
   * @param {Object} opts
   * @param {String} opts.wallet - name of (HD) wallet
   * @param {String} opts.hdpath - derivation path, without index (ex: "m/44'/5'/0'/0")
   * @param {Number} opts.index - xpub or hdpath index
   * @returns {WalletAddress}
   */
  Wallet.generateAddress = function ({ wallet, hdpath, index }) {
    return {
      checked_at: 0,
      hdpath: hdpath,
      index: index,
      txs: [],
      utxos: [],
      wallet: wallet,
    };
  };

  /**
   * Generate a wallet with creation date set
   * @param {Object} opts
   * @param {String} opts.name - machine friendly (lower case, no spaces)
   * @param {String} opts.label - human friendly
   * @param {Number} opts.priority - sparse index, higher is higher
   * @param {String?} [opts.contact] - handle of contact
   * @returns {PrivateWallet}
   */
  Wallet.generate = function ({ name, label, priority, contact = null }) {
    let mnemonic = Bip39.generateMnemonic();
    if (!priority) {
      priority = Date.now();
    }
    //let mnemonic = await Passphrase.generate(128);
    return {
      name: name.toLowerCase(),
      label: label,
      device: null,
      contact: contact,
      priority: 0,
      mnemonic: mnemonic.split(/[,\s\n\|]+/g),
      created_at: new Date().toISOString(),
      archived_at: null,
    };
  };

  /**
   * Generate a wallet with creation date set
   * @param {Object} opts
   * @param {String} opts.handle
   * @param {String} opts.xpub
   * @param {String} opts.addr
   * @returns {PayWallet}
   */
  Wallet.generatePayWallet = function ({ handle, xpub, addr }) {
    let d = new Date();
    return {
      contact: handle,
      device: null,
      label: handle,
      name: handle.toLowerCase(),
      priority: d.valueOf(),
      addr: addr,
      xpub: xpub,
      created_at: d.toISOString(),
      archived_at: null,
    };
  };

  /**
   * @param {String} xpub
   * @throws {Error}
   */
  Wallet.assertXPub = function (xpub) {
    try {
      HdKey.fromExtendedKey(xpub);
    } catch (e) {
      //@ts-ignore - tsc bug
      if (!e.message.includes("Invalid checksum")) {
        throw e;
      }
      throw new Error(
        `failed to parse contact's xpub (bad checksum): '${xpub}'`,
      );
    }
  };

  /**
   * @param {String} xpub
   * @returns {Boolean} - is xpub with valid checksum
   */
  Wallet.isXPub = function (xpub = "") {
    // TODO check length

    if (!xpub.startsWith("xpub")) {
      return false;
    }

    try {
      Wallet.assertXPub(xpub);
    } catch (e) {
      return false;
    }

    return true;
  };

  if ("undefined" !== typeof module) {
    module.exports = Wallet;
  }
})(("undefined" !== typeof module && module.exports) || window);
