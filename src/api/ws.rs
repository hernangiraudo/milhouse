use super::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};

pub async fn ws_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, id))
}

async fn handle_socket(socket: WebSocket, state: AppState, job_id: String) {
    let (mut sender, mut receiver) = socket.split();

    let handle = match state.jobs.get(&job_id) {
        Some(h) => h.clone(),
        None => {
            let _ = sender
                .send(Message::Text(
                    serde_json::json!({
                        "type": "error",
                        "message": "job not found"
                    })
                    .to_string(),
                ))
                .await;
            return;
        }
    };

    // Enviar snapshot inicial
    let snap = handle.snapshot().await;
    let _ = sender
        .send(Message::Text(
            serde_json::json!({
                "type": "snapshot",
                "state": snap,
            })
            .to_string(),
        ))
        .await;

    let mut rx = handle.subscribe();

    // Tarea para reenviar broadcasts al websocket
    let send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let txt = serde_json::to_string(&ev).unwrap_or_default();
                    if sender.send(Message::Text(txt)).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // Tarea para ignorar mensajes del cliente / detectar cierre
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}
