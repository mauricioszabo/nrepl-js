(ns nrepl-js.ops
  (:require ["node:crypto" :refer [randomUUID]]
            [nrepl-js.eval :as ev]
            [promesa.core :as p]))

(def ^:private supported-ops
  {"clone" {:doc "Create a new session."}
   "close" {:doc "Close a session."}
   "describe" {:doc "Describe supported ops."}
   "eval" {:doc "Evaluate code in a session. Pass `file` to enable live-patch routing."}
   "ls-sessions" {:doc "List active sessions."}
   "interrupt" {:doc "Interrupt the running eval (best-effort via Runtime.terminateExecution)."}})

(defn- op-describe [{:keys [^js msg send]}]
  (let [ops (reduce-kv (fn [acc k v] (aset acc k #js {:doc (:doc v)}) acc) #js {} supported-ops)]
    (send #js {:id (.-id msg)
               :ops ops
               :versions #js {:nrepl-js #js {:major 0 :minor 1 :incremental 0 :version-string "0.1.0"}}
               :status (array "done")})))

(defn- op-clone [{:keys [^js msg ^js ctx send]}]
  (let [id (randomUUID)
        session #js {:id id :contextId (.-defaultContextId ctx) :lastEvalId nil}]
    (.set (.-sessions ctx) id session)
    (send #js {:id (.-id msg) :new-session id :status (array "done")})))

(defn- op-close [{:keys [^js msg ^js ctx send]}]
  (let [sid (.-session msg)]
    (when sid (.delete (.-sessions ctx) sid))
    (send #js {:id (.-id msg) :session sid :status (array "done" "session-closed")})))

(defn- op-ls-sessions [{:keys [^js msg ^js ctx send]}]
  (send #js {:id (.-id msg)
             :sessions (js/Array.from (.keys (.-sessions ctx)))
             :status (array "done")}))

(defn- op-eval [{:keys [^js msg ^js ctx send]}]
  (let [session (.get (.-sessions ctx) (.-session msg))]
    (if-not session
      (send #js {:id (.-id msg) :status (array "done" "error" "unknown-session")})
      (do
        (set! (.-activeEvalSession ctx) session)
        (-> (ev/handle-eval {:msg msg
                             :session session
                             :cdp (.-cdp ctx)
                             :scripts (.-scripts ctx)
                             :send send})
            (p/finally (fn [] (set! (.-activeEvalSession ctx) nil))))))))

(defn- op-interrupt [{:keys [^js msg ^js ctx send]}]
  (let [^js cdp (.-cdp ctx)]
    (-> (.call (.-send cdp) cdp "Runtime.terminateExecution")
        (p/then (fn [_] (send #js {:id (.-id msg) :status (array "done" "interrupted")})))
        (p/catch (fn [err] (send #js {:id (.-id msg)
                                      :err (str "interrupt failed: " (.-message err) "\n")
                                      :status (array "done" "error")}))))))

(defn dispatch [{:keys [^js msg ctx send]}]
  (let [op (.-op msg)]
    (case op
      "clone" (op-clone {:msg msg :ctx ctx :send send})
      "close" (op-close {:msg msg :ctx ctx :send send})
      "describe" (op-describe {:msg msg :send send})
      "eval" (op-eval {:msg msg :ctx ctx :send send})
      "ls-sessions" (op-ls-sessions {:msg msg :ctx ctx :send send})
      "interrupt" (op-interrupt {:msg msg :ctx ctx :send send})
      (send #js {:id (.-id msg) :status (array "done" "error" "unknown-op")}))))
