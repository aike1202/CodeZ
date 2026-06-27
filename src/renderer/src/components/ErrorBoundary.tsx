import React, { Component, ErrorInfo, ReactNode } from 'react'
import Button from './ui/Button'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import Card from './ui/Card'
import IconWarning from './icons/IconWarning'
import './ErrorBoundary.css'

interface Props {
  children?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in React Tree:', error, errorInfo)
    this.setState({
      error,
      errorInfo
    })
  }

  private handleReload = () => {
    // 强制刷新整个应用
    window.location.reload()
  }

  public render() {
    if (this.state.hasError) {
      return (
        <Flex className="error-boundary-container">
          <Card variant="default" className="error-boundary-card">
            <Stack gap={3}>
              <Flex className="error-boundary-header">
                <IconWarning className="error-warning-icon" />
                <h1 className="error-title">程序遇到了一点问题</h1>
              </Flex>
              
              <p className="error-desc">
                很抱歉，应用在渲染界面时发生了意外错误。您可以尝试刷新应用来恢复。
              </p>

              <div className="error-details-box">
                <div className="error-label">错误信息：</div>
                <code className="error-message">
                  {this.state.error?.toString()}
                </code>
                {this.state.errorInfo?.componentStack && (
                  <div className="error-stack-wrapper">
                    <div className="error-label">组件调用栈：</div>
                    <pre className="error-stack-trace">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  </div>
                )}
              </div>

              <Flex justify="end">
                <Button
                  onClick={this.handleReload}
                  variant="danger"
                  size="none"
                  className="error-reload-btn"
                >
                  重新加载应用
                </Button>
              </Flex>
            </Stack>
          </Card>
        </Flex>
      )
    }

    return this.props.children
  }
}
