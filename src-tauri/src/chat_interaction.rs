use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use codez_contracts::chat::{
    ChatAskUserAnswer, ChatAskUserAnswerValue, ChatAskUserQuestion, ChatAskUserRequest,
};
use codez_core::{AppError, StreamId, ToolCallId};
use tokio::sync::oneshot;

const ASK_USER_IGNORED: &str = "__IGNORED__";
const MAX_PENDING_ASK_USER_REQUESTS: usize = 256;
const ASK_USER_REQUEST_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_ASK_USER_QUESTIONS: usize = 4;
const MIN_ASK_USER_OPTIONS: usize = 2;
const MAX_ASK_USER_OPTIONS: usize = 4;
const MAX_QUESTION_BYTES: usize = 8 * 1024;
const MAX_HEADER_BYTES: usize = 512;
const MAX_OPTION_LABEL_BYTES: usize = 512;
const MAX_OPTION_DESCRIPTION_BYTES: usize = 8 * 1024;
const MAX_OPTION_DETAIL_BYTES: usize = 64 * 1024;
const MAX_BUTTON_LABEL_BYTES: usize = 16;
const MAX_ANSWER_BYTES: usize = 16 * 1024;

pub(crate) struct AskUserResponseRegistry {
    pending: Mutex<PendingAskUserRequests>,
}

#[derive(Default)]
struct PendingAskUserRequests {
    by_id: HashMap<String, PendingAskUserRequest>,
}

struct PendingAskUserRequest {
    run_id: StreamId,
    request: ChatAskUserRequest,
    created_at: Instant,
    response: oneshot::Sender<Vec<ChatAskUserAnswer>>,
}

impl AskUserResponseRegistry {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            pending: Mutex::new(PendingAskUserRequests::default()),
        }
    }

    pub(crate) fn register(
        &self,
        run_id: &StreamId,
        request: ChatAskUserRequest,
    ) -> Result<oneshot::Receiver<Vec<ChatAskUserAnswer>>, AppError> {
        validate_request(&request)?;
        let request_id = request.id.clone();
        let (response, receiver) = oneshot::channel();
        let mut pending = self.lock();
        pending.prune_expired();
        if pending.by_id.len() >= MAX_PENDING_ASK_USER_REQUESTS {
            return Err(AppError::conflict(
                "Too many user-interaction requests are awaiting answers",
            ));
        }
        if pending.by_id.contains_key(&request_id) {
            return Err(AppError::conflict(
                "A user-interaction request with this ID is already active",
            ));
        }
        pending.by_id.insert(
            request_id,
            PendingAskUserRequest {
                run_id: run_id.clone(),
                request,
                created_at: Instant::now(),
                response,
            },
        );
        Ok(receiver)
    }

    pub(crate) fn resolve(
        &self,
        request_id: &str,
        answers: Vec<ChatAskUserAnswer>,
    ) -> Result<(), AppError> {
        let pending_request = {
            let mut pending = self.lock();
            pending.prune_expired();
            let Some(request) = pending.by_id.get(request_id) else {
                return Err(AppError::not_found(
                    "The user-interaction request is no longer active",
                ));
            };
            validate_answers(&request.request, &answers)?;
            pending.by_id.remove(request_id).ok_or_else(|| {
                AppError::internal("active user-interaction request disappeared while resolving")
            })?
        };

        pending_request.response.send(answers).map_err(|_| {
            AppError::conflict("The user-interaction request is no longer awaiting a response")
        })
    }

    pub(crate) fn cancel(&self, request_id: &str) {
        self.lock().by_id.remove(request_id);
    }

    pub(crate) fn cancel_for_run(&self, run_id: &StreamId) {
        self.lock()
            .by_id
            .retain(|_, request| request.run_id != *run_id);
    }

    fn lock(&self) -> MutexGuard<'_, PendingAskUserRequests> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl PendingAskUserRequests {
    fn prune_expired(&mut self) {
        self.by_id
            .retain(|_, request| request.created_at.elapsed() <= ASK_USER_REQUEST_TTL);
    }
}

pub(crate) fn validate_request(request: &ChatAskUserRequest) -> Result<(), AppError> {
    ToolCallId::parse(request.id.clone())
        .map_err(|error| AppError::validation(format!("Invalid ask-user request ID: {error}")))?;
    if request.questions.is_empty() || request.questions.len() > MAX_ASK_USER_QUESTIONS {
        return Err(AppError::validation(
            "An ask-user request must contain between one and four questions",
        ));
    }

    let mut questions = HashSet::with_capacity(request.questions.len());
    for question in &request.questions {
        validate_question(question)?;
        if !questions.insert(question.question.as_str()) {
            return Err(AppError::validation(
                "An ask-user request cannot contain duplicate questions",
            ));
        }
    }
    Ok(())
}

fn validate_question(question: &ChatAskUserQuestion) -> Result<(), AppError> {
    validate_required_text(
        &question.question,
        MAX_QUESTION_BYTES,
        "Ask-user question text is required",
    )?;
    validate_required_text(
        &question.header,
        MAX_HEADER_BYTES,
        "Ask-user question header is required",
    )?;
    if question.options.len() < MIN_ASK_USER_OPTIONS
        || question.options.len() > MAX_ASK_USER_OPTIONS
    {
        return Err(AppError::validation(
            "Each ask-user question must contain between two and four options",
        ));
    }

    let mut option_labels = HashSet::with_capacity(question.options.len());
    for option in &question.options {
        validate_required_text(
            &option.label,
            MAX_OPTION_LABEL_BYTES,
            "Ask-user option labels are required",
        )?;
        if option.label == ASK_USER_IGNORED {
            return Err(AppError::validation(
                "Ask-user option labels cannot use the ignored-answer marker",
            ));
        }
        if !option_labels.insert(option.label.as_str()) {
            return Err(AppError::validation(
                "Ask-user question options must have unique labels",
            ));
        }
        validate_optional_text(
            option.description.as_deref(),
            MAX_OPTION_DESCRIPTION_BYTES,
            "Ask-user option descriptions exceed the size limit",
        )?;
        validate_optional_text(
            option.detail.as_deref(),
            MAX_OPTION_DETAIL_BYTES,
            "Ask-user option details exceed the size limit",
        )?;
    }
    validate_optional_button_label(
        question.ignore_label.as_deref(),
        "Ask-user ignore labels must contain between one and sixteen bytes",
    )?;
    validate_optional_button_label(
        question.submit_label.as_deref(),
        "Ask-user submit labels must contain between one and sixteen bytes",
    )?;
    Ok(())
}

fn validate_answers(
    request: &ChatAskUserRequest,
    answers: &[ChatAskUserAnswer],
) -> Result<(), AppError> {
    if answers.len() != request.questions.len() {
        return Err(AppError::validation(
            "Ask-user answers must include every requested question exactly once",
        ));
    }

    let mut answered_questions = HashSet::with_capacity(answers.len());
    for answer in answers {
        let Some(question) = request
            .questions
            .iter()
            .find(|question| question.question == answer.question)
        else {
            return Err(AppError::validation(
                "An ask-user answer does not match an active question",
            ));
        };
        if !answered_questions.insert(answer.question.as_str()) {
            return Err(AppError::validation(
                "Ask-user answers cannot answer the same question twice",
            ));
        }
        match (&answer.answer, question.multi_select.unwrap_or(false)) {
            (ChatAskUserAnswerValue::Text(value), false) => validate_text_answer(value)?,
            (ChatAskUserAnswerValue::Selection(values), true) => {
                validate_selection_answer(question, values)?;
            }
            (ChatAskUserAnswerValue::Text(_), true) => {
                return Err(AppError::validation(
                    "Multi-select ask-user questions require a selection array",
                ));
            }
            (ChatAskUserAnswerValue::Selection(_), false) => {
                return Err(AppError::validation(
                    "Single-select ask-user questions require a text answer",
                ));
            }
        }
    }
    Ok(())
}

fn validate_text_answer(value: &str) -> Result<(), AppError> {
    validate_required_text(
        value,
        MAX_ANSWER_BYTES,
        "Ask-user answers must contain non-empty text within the size limit",
    )
}

fn validate_selection_answer(
    question: &ChatAskUserQuestion,
    selections: &[String],
) -> Result<(), AppError> {
    if selections.is_empty() || selections.len() > question.options.len() + 1 {
        return Err(AppError::validation(
            "Ask-user selections exceed the allowed option count",
        ));
    }
    if selections
        .iter()
        .any(|selection| selection == ASK_USER_IGNORED)
    {
        if selections.len() == 1 {
            return Ok(());
        }
        return Err(AppError::validation(
            "The ignored-answer marker cannot be combined with other selections",
        ));
    }

    let option_labels = question
        .options
        .iter()
        .map(|option| option.label.as_str())
        .collect::<HashSet<_>>();
    let mut selections_seen = HashSet::with_capacity(selections.len());
    let mut custom_answers = 0_usize;
    for selection in selections {
        validate_required_text(
            selection,
            MAX_ANSWER_BYTES,
            "Ask-user selections must contain non-empty text within the size limit",
        )?;
        if !selections_seen.insert(selection.as_str()) {
            return Err(AppError::validation(
                "Ask-user selections cannot contain duplicate values",
            ));
        }
        if !option_labels.contains(selection.as_str()) {
            custom_answers += 1;
        }
    }
    if custom_answers > 1 {
        return Err(AppError::validation(
            "Ask-user selections can contain at most one custom answer",
        ));
    }
    Ok(())
}

fn validate_required_text(
    value: &str,
    max_bytes: usize,
    message: &'static str,
) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(AppError::validation(message));
    }
    Ok(())
}

fn validate_optional_text(
    value: Option<&str>,
    max_bytes: usize,
    message: &'static str,
) -> Result<(), AppError> {
    if value.is_some_and(|value| value.len() > max_bytes) {
        return Err(AppError::validation(message));
    }
    Ok(())
}

fn validate_optional_button_label(
    value: Option<&str>,
    message: &'static str,
) -> Result<(), AppError> {
    if value.is_some_and(|value| value.trim().is_empty() || value.len() > MAX_BUTTON_LABEL_BYTES) {
        return Err(AppError::validation(message));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use codez_contracts::chat::{
        ChatAskUserAnswer, ChatAskUserAnswerValue, ChatAskUserOption, ChatAskUserQuestion,
        ChatAskUserRequest,
    };
    use codez_core::{AppErrorKind, StreamId};

    use super::{ASK_USER_REQUEST_TTL, AskUserResponseRegistry};

    #[tokio::test]
    async fn response_registry_should_deliver_a_valid_response_once() {
        let registry = AskUserResponseRegistry::new();
        let request = request(false);
        let receiver = registry
            .register(&stream_id(), request.clone())
            .expect("fixture request must register");
        let answers = vec![ChatAskUserAnswer {
            question: request.questions[0].question.clone(),
            answer: ChatAskUserAnswerValue::Text("first".to_string()),
        }];

        registry
            .resolve(&request.id, answers.clone())
            .expect("valid response must resolve the pending request");
        let received = receiver
            .await
            .expect("registered receiver must receive the answer");

        assert_eq!(received, answers);
    }

    #[tokio::test]
    async fn response_registry_should_keep_a_request_pending_after_invalid_answers() {
        let registry = AskUserResponseRegistry::new();
        let request = request(false);
        let receiver = registry
            .register(&stream_id(), request.clone())
            .expect("fixture request must register");
        let invalid = vec![ChatAskUserAnswer {
            question: "different question".to_string(),
            answer: ChatAskUserAnswerValue::Text("first".to_string()),
        }];

        let error = registry
            .resolve(&request.id, invalid)
            .expect_err("unknown questions must not resolve a pending request");
        registry
            .resolve(
                &request.id,
                vec![ChatAskUserAnswer {
                    question: request.questions[0].question.clone(),
                    answer: ChatAskUserAnswerValue::Text("first".to_string()),
                }],
            )
            .expect("a valid response must still resolve the pending request");
        let received = receiver.await.expect("valid response must be delivered");

        assert!(error.kind() == AppErrorKind::Validation && received.len() == 1);
    }

    #[tokio::test]
    async fn response_registry_should_close_pending_receivers_when_a_run_is_cancelled() {
        let registry = AskUserResponseRegistry::new();
        let run_id = stream_id();
        let receiver = registry
            .register(&run_id, request(false))
            .expect("fixture request must register");

        registry.cancel_for_run(&run_id);
        let result = receiver.await;

        assert!(result.is_err());
    }

    #[test]
    fn response_registry_should_expire_stale_requests() {
        let registry = AskUserResponseRegistry::new();
        let request = request(false);
        let _receiver = registry
            .register(&stream_id(), request.clone())
            .expect("fixture request must register");
        {
            let mut pending = registry.lock();
            let entry = pending
                .by_id
                .get_mut(&request.id)
                .expect("fixture request must be present");
            entry.created_at = std::time::Instant::now()
                - ASK_USER_REQUEST_TTL
                - std::time::Duration::from_secs(1);
        }

        let error = registry
            .resolve(
                &request.id,
                vec![ChatAskUserAnswer {
                    question: request.questions[0].question.clone(),
                    answer: ChatAskUserAnswerValue::Text("first".to_string()),
                }],
            )
            .expect_err("expired requests must not accept answers");

        assert_eq!(error.kind(), AppErrorKind::NotFound);
    }

    fn stream_id() -> StreamId {
        StreamId::parse("stream-1").expect("fixture stream ID must be valid")
    }

    fn request(multi_select: bool) -> ChatAskUserRequest {
        ChatAskUserRequest {
            id: "ask-user-1".to_string(),
            questions: vec![ChatAskUserQuestion {
                question: "Which option?".to_string(),
                header: "Choice".to_string(),
                options: vec![
                    ChatAskUserOption {
                        label: "first".to_string(),
                        description: None,
                        detail: None,
                    },
                    ChatAskUserOption {
                        label: "second".to_string(),
                        description: None,
                        detail: None,
                    },
                ],
                multi_select: Some(multi_select),
                ignore_label: None,
                submit_label: None,
            }],
        }
    }
}
