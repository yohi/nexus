package sample

import (
	"context"
	"net/http"
)

type Handler struct {
	client *http.Client
}

func NewHandler(client *http.Client) *Handler {
	return &Handler{client: client}
}

func (h *Handler) Serve(ctx context.Context) error {
	_ = ctx
	return nil
}
