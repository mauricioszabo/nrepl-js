(ns nrepl-js.ops
  (:require ["node:crypto" :refer [randomUUID]]
            [nrepl-js.cdp-interop :as cdp]
            [nrepl-js.evaluate :as evaluate]
            [promesa.core :as p]))

(def ^:private supported-ops
  {"clone" {:doc "Create a new session."}
   "close" {:doc "Close a session."}
   "describe" {:doc "Describe supported ops."}
   "eval" {:doc "Evaluate code in a session. Pass `file` to enable live-patch routing."}
   "ls-sessions" {:doc "List active sessions."}
   "interrupt" {:doc "Interrupt the running eval (best-effort via Runtime.terminateExecution)."}})

(defn- op-describe [{:keys [msg send]}]
  (send {:id (:id msg)
         :ops (into {} (map (fn [[k v]] [k {:doc (:doc v)}])) supported-ops)
         :versions {:nrepl-js {:major 0
                               :minor 1
                               :incremental 0
                               :version-string "0.1.0"}}
         :status ["done"]}))

(defn- op-clone [{:keys [msg ctx send]}]
  (let [id (randomUUID)
        session {:id id
                 :context-id @(:default-context-id ctx)
                 :last-eval-id nil}]
    (swap! (:sessions ctx) assoc id session)
    (send {:id (:id msg) :new-session id :status ["done"]})))

(defn- op-close [{:keys [msg ctx send]}]
  (let [sid (:session msg)]
    (when sid (swap! (:sessions ctx) dissoc sid))
    (send {:id (:id msg) :session sid :status ["done" "session-closed"]})))

(defn- op-ls-sessions [{:keys [msg ctx send]}]
  (send {:id (:id msg)
         :sessions (vec (keys @(:sessions ctx)))
         :status ["done"]}))

(defn- op-eval [{:keys [msg ctx send]}]
  (let [session (get @(:sessions ctx) (:session msg))]
    (if-not session
      (send {:id (:id msg) :status ["done" "error" "unknown-session"]})
      (do
        (reset! (:active-eval-session ctx) session)
        (-> (evaluate/handle-eval {:msg msg
                                   :session session
                                   :cdp (:cdp ctx)
                                   :scripts (:scripts ctx)
                                   :send send})
            (p/finally (fn [] (reset! (:active-eval-session ctx) nil))))))))

(defn- op-interrupt [{:keys [msg ctx send]}]
  (let [cdp (:cdp ctx)]
    (-> (cdp/call cdp "Runtime.terminateExecution")
        (p/then (fn [_] (send {:id (:id msg) :status ["done" "interrupted"]})))
        (p/catch (fn [err] (send {:id (:id msg)
                                  :err (str "interrupt failed: " (.-message err) "\n")
                                  :status ["done" "error"]}))))))

(defn dispatch [{:keys [msg ctx send]}]
  (let [op (:op msg)]
    (case op
      "clone" (op-clone {:msg msg :ctx ctx :send send})
      "close" (op-close {:msg msg :ctx ctx :send send})
      "describe" (op-describe {:msg msg :send send})
      "eval" (op-eval {:msg msg :ctx ctx :send send})
      "ls-sessions" (op-ls-sessions {:msg msg :ctx ctx :send send})
      "interrupt" (op-interrupt {:msg msg :ctx ctx :send send})
      (send {:id (:id msg) :status ["done" "error" "unknown-op"]}))))
