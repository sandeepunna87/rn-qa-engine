// Jenkins declarative pipeline for the RN QA Engine.
//
// Design intent: the engine NEVER pushes to the branch under review and never
// fails a developer's build on its own output. It opens a separate PR that a
// human merges. A quality tool that can block a release on a generated test is
// a tool teams will route around within a month.

pipeline {
  agent { label 'nodejs-20' }

  options {
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
  }

  parameters {
    booleanParam(name: 'APPLY', defaultValue: true,  description: 'Open a PR with accepted changes')
    string(name: 'MAX_TASKS',   defaultValue: '5',   description: 'Files to process per run')
    string(name: 'ONLY',        defaultValue: '',    description: 'Restrict to paths matching this substring')
  }

  environment {
    // Secrets come from Jenkins credentials, never from rnqa.config.json.
    SONAR_TOKEN   = credentials('sonarqube-token')
    LLM_BASE_URL  = 'http://llm-gateway.internal:4000'   // on-prem gateway
    GIT_AUTHOR_NAME  = 'rn-qa-engine'
    GIT_AUTHOR_EMAIL = 'rn-qa-engine@noreply.internal'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        sh 'git rev-parse HEAD'
      }
    }

    stage('Install') {
      steps {
        sh 'npm ci'
        // The mutation gate is the engine's credibility. Fail loudly if absent
        // rather than letting it silently "skip".
        sh 'npm ls @stryker-mutator/core @stryker-mutator/jest-runner'
      }
    }

    stage('Analyse (no model)') {
      steps {
        sh """
          npx rnqa analyse \
            --project "\$WORKSPACE" \
            --json > rnqa-plan.json
        """
        archiveArtifacts artifacts: 'rnqa-plan.json', allowEmptyArchive: true
      }
    }

    stage('Generate + verify') {
      steps {
        script {
          def onlyFlag = params.ONLY?.trim() ? "--only '${params.ONLY.trim()}'" : ''
          def prId = env.CHANGE_ID ? "--pull-request ${env.CHANGE_ID}" : "--branch ${env.BRANCH_NAME}"
          // Exit 1 means "nothing survived the gates" — informational, not a
          // build failure. The engine reports; it does not gate the release.
          sh """
            set +e
            npx rnqa run \
              --project "\$WORKSPACE" \
              ${prId} ${onlyFlag} \
              --report rnqa-report.html \
              ${params.APPLY ? '--apply' : ''}
            echo "rnqa exit: \$?"
            exit 0
          """
        }
      }
    }

    stage('Publish report') {
      steps {
        archiveArtifacts artifacts: 'rnqa-report.html', allowEmptyArchive: true
        publishHTML(target: [
          reportDir: '.', reportFiles: 'rnqa-report.html',
          reportName: 'RN QA Engine', keepAll: true,
          alwaysLinkToLastBuild: true, allowMissing: true
        ])
      }
    }

    stage('Open PR') {
      when {
        allOf {
          expression { params.APPLY }
          expression { sh(script: 'git status --porcelain | grep . >/dev/null', returnStatus: true) == 0 }
        }
      }
      steps {
        withCredentials([usernamePassword(
          credentialsId: 'scm-bot', usernameVariable: 'GIT_USER', passwordVariable: 'GIT_PASS'
        )]) {
          sh '''
            BRANCH="rnqa/${BUILD_NUMBER}"
            git config user.name  "$GIT_AUTHOR_NAME"
            git config user.email "$GIT_AUTHOR_EMAIL"
            git checkout -b "$BRANCH"
            git add -A
            git commit -m "test(rnqa): generated tests and Sonar fixes [build ${BUILD_NUMBER}]

Every change in this PR passed: typecheck, generated tests, full existing
suite, branch-coverage delta, and mutation score. See the archived
rnqa-report.html for per-file gate results.

Tier C findings (auth/crypto/payment paths, Sonar VULNERABILITY) were
reported only — no code was generated for them."
            git push origin "$BRANCH"
          '''
        }
      }
    }
  }

  post {
    always {
      cleanWs(deleteDirs: true, notFailBuild: true)
    }
  }
}
