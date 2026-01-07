import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  CssBaseline,
  Divider,
  IconButton,
  Link as MuiLink,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined'
import LaunchIcon from '@mui/icons-material/Launch'
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline'
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'
const JOB_POLL_INTERVAL_MS = 2000
const MANIFEST_CACHE_PREFIX = 'manifest_cache_'
const MANIFEST_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000

const ensureUserId = () => {
  if (typeof document === 'undefined') return 'local-user'

  const cookie = document.cookie
    .split('; ')
    .find((row) => row.startsWith('user_id='))

  if (cookie) return cookie.split('=')[1]

  const generated = crypto.randomUUID()
  document.cookie = `user_id=${generated}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  return generated
}

const manifestCookieKey = (userId) => `${MANIFEST_CACHE_PREFIX}${userId}`

const readCookie = (name) => {
  if (typeof document === 'undefined') return null
  const cookies = document.cookie ? document.cookie.split(';') : []
  for (const cookie of cookies) {
    const trimmed = cookie.trim()
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.substring(name.length + 1)
    }
  }
  return null
}

const readManifestCache = (userId) => {
  if (!userId) return null
  const key = manifestCookieKey(userId)
  const value = readCookie(key)
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value))
    if (!parsed || !Array.isArray(parsed.files)) {
      return null
    }
    const updatedAt = Date.parse(parsed.updatedAt || '')
    const isStale = Number.isNaN(updatedAt) ? true : Date.now() - updatedAt > MANIFEST_CACHE_TTL_MS
    return { data: parsed, isStale }
  } catch {
    return null
  }
}

const writeManifestCache = (userId, manifest) => {
  if (typeof document === 'undefined' || !userId) return
  const key = manifestCookieKey(userId)
  try {
    const serialized = encodeURIComponent(JSON.stringify(manifest))
    document.cookie = `${key}=${serialized}; path=/; max-age=${MANIFEST_CACHE_MAX_AGE_SECONDS}; samesite=lax`
  } catch {
    // Ignore serialization errors
  }
}

const mapManifestEntriesToState = (entries = []) =>
  entries
    .filter((file) => file && (file.slug || file.fileName))
    .map((file) => ({
      id: crypto.randomUUID(),
      name: file.fileName || file.slug || 'Stored file',
      size: typeof file.size === 'number' ? file.size : 0,
      status: file.status ?? 'uploaded',
      slug: file.slug ?? '',
      s3Url: file.s3Url ?? '',
      error: '',
      deleting: false,
      persisted: true,
    }))

const mergePersistedEntries = (persistedEntries, prevFiles) => {
  const transient = prevFiles.filter((entry) => !entry.persisted)
  return [...persistedEntries, ...transient]
}

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

const isValidHttpUrl = (url) => {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const apiUrl = (path) => {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return new URL(normalized, API_BASE_URL).toString()
}

const apiFetch = async (path, options = {}) => {
  const response = await fetch(apiUrl(path), options)
  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const data = isJson ? await response.json() : await response.text()

  if (!response.ok) {
    const message =
      (typeof data === 'string' && data) ||
      (typeof data === 'object' && data !== null && (data.detail || data.message)) ||
      `Request failed (${response.status})`
    throw new Error(message)
  }

  return data
}

const statusLabelMap = {
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  processing: 'Processing',
  error: 'Error',
}

const jobStatusLabel = {
  idle: 'Waiting on uploads + form link',
  queued: 'Job queued',
  filling: 'Running pipeline',
  complete: 'Filled PDF ready',
  error: 'Job failed',
}

const jobStatusColor = {
  idle: 'default',
  queued: 'info',
  filling: 'info',
  complete: 'success',
  error: 'error',
}

function App() {
  const [userId] = useState(() => ensureUserId())
  const [formUrl, setFormUrl] = useState('')
  const [files, setFilesState] = useState([])
  const [manifestError, setManifestError] = useState('')
  const [jobStatus, setJobStatus] = useState('idle')
  const [jobId, setJobId] = useState('')
  const [jobError, setJobError] = useState('')
  const [filledFormUrl, setFilledFormUrl] = useState('')
  const [manifestLoading, setManifestLoading] = useState(true)
  const pollTimer = useRef(null)

  const persistFilesToCache = useCallback(
    (nextFiles) => {
      const manifestPayload = {
        updatedAt: new Date().toISOString(),
        files: nextFiles
          .filter((file) => file.slug)
          .map((file) => ({
          status: file.status,
          slug: file.slug,
          fileName: file.name,
          s3Url: file.s3Url,
          size: file.size,
        })),
    }
    writeManifestCache(userId, manifestPayload)
    },
    [userId],
  )

  const updateFiles = useCallback(
    (updater, options = {}) => {
      setFilesState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        if (!options.skipCache) {
          persistFilesToCache(next)
        }
        return next
      })
    },
    [persistFilesToCache],
  )

  const applyManifestEntries = useCallback(
    (entries, options = {}) => {
      updateFiles((prev) => mergePersistedEntries(entries, prev), options)
    },
    [updateFiles],
  )

  const hydrateUploads = useCallback(
    async ({ ignoreCache = false, signal } = {}) => {
      const isAborted = () => Boolean(signal?.aborted)

      if (!ignoreCache) {
        const cachedResult = readManifestCache(userId)
        if (cachedResult?.data) {
          const cachedEntries = mapManifestEntriesToState(cachedResult.data.files)
          if (isAborted()) return
          applyManifestEntries(cachedEntries, { skipCache: true })
          setManifestError('')
          if (!cachedResult.isStale) {
            setManifestLoading(false)
            return
          }
        }
      }

      if (isAborted()) return
      setManifestLoading(true)

      try {
        const params = new URLSearchParams({ userId })
        const response = await apiFetch(`/api/uploads?${params}`)
        if (isAborted()) return

        const persistedEntries = mapManifestEntriesToState(response.files ?? [])
        applyManifestEntries(persistedEntries)
        setManifestError('')
      } catch (error) {
        if (isAborted()) return
        setManifestError(error.message || 'Failed to load previous uploads.')
      } finally {
        if (isAborted()) return
        setManifestLoading(false)
      }
    },
    [applyManifestEntries, userId],
  )

  useEffect(() => {
    return () => {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current)
      }
    }
  }, [])

  useEffect(() => {
    const abortController = new AbortController()
    void hydrateUploads({ signal: abortController.signal })
    return () => {
      abortController.abort()
    }
  }, [hydrateUploads])

  const formUrlIsValid = isValidHttpUrl(formUrl)
  const allUploadsComplete = files.length > 0 && files.every((file) => file.status === 'uploaded')
  const canStartFill = formUrlIsValid && allUploadsComplete && jobStatus !== 'filling' && jobStatus !== 'queued'

  const updateFile = (id, next) => {
    updateFiles((prev) => prev.map((file) => (file.id === id ? { ...file, ...next } : file)))
  }

  const removeFile = (id) => {
    updateFiles((prev) => prev.filter((file) => file.id !== id))
  }

  const handleFilesSelected = (event) => {
    const selectedFiles = Array.from(event.target.files ?? [])
    if (selectedFiles.length === 0) return

    const entries = selectedFiles.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      status: 'uploading',
      slug: '',
      s3Url: '',
      error: '',
      deleting: false,
      persisted: false,
    }))

    updateFiles((prev) => [...prev, ...entries])

    entries.forEach((entry, index) => {
      void uploadDocument(entry.id, selectedFiles[index])
    })

    event.target.value = ''
  }

  const handleRefreshUploads = () => {
    void hydrateUploads({ ignoreCache: true })
  }

  const uploadDocument = async (entryId, file) => {
    updateFile(entryId, { status: 'uploading', error: '' })

    const formData = new FormData()
    formData.append('userId', userId)
    if (formUrlIsValid) {
      formData.append('formUrl', formUrl)
    }
    formData.append('file', file)

    try {
      const response = await apiFetch('/api/uploads', {
        method: 'POST',
        body: formData,
      })

      const nextStatus = response.status ?? 'uploaded'

      updateFile(entryId, {
        status: nextStatus,
        s3Url: response.s3Url ?? '',
        slug: response.slug ?? '',
        error: '',
        size: typeof response.size === 'number' ? response.size : file.size,
        persisted: true,
      })

      if (nextStatus === 'processing') {
        setTimeout(() => {
          updateFile(entryId, { status: 'uploaded' })
        }, 1200 + Math.random() * 1200)
      }
    } catch (error) {
      updateFile(entryId, {
        status: 'error',
        error: error.message || 'Upload failed',
        s3Url: '',
        slug: '',
      })
    }
  }

  const handleDelete = async (file) => {
    if (!file.slug) {
      removeFile(file.id)
      return
    }

    updateFile(file.id, { deleting: true, error: '' })

    try {
      const params = new URLSearchParams({ userId })
      await apiFetch(`/api/uploads/${file.slug}?${params}`, {
        method: 'DELETE',
      })
      removeFile(file.id)
    } catch (error) {
      updateFile(file.id, { deleting: false, error: error.message || 'Unable to delete' })
    }
  }

  const clearExistingPoll = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }

  const scheduleJobPoll = (pollJobId, formLink) => {
    clearExistingPoll()
    pollTimer.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ userId, formUrl: formLink })
        const response = await apiFetch(`/api/form-fill/${pollJobId}?${params}`)
        setJobStatus(response.status)
        setFilledFormUrl(response.filledFormUrl ?? '')

        if (response.status === 'complete' || response.status === 'error') {
          setJobError(response.status === 'error' ? 'Pipeline reported an error.' : '')
          clearExistingPoll()
        } else {
          scheduleJobPoll(pollJobId, formLink)
        }
      } catch (error) {
        setJobStatus('error')
        setJobError(error.message || 'Polling failed')
        clearExistingPoll()
      }
    }, JOB_POLL_INTERVAL_MS)
  }

  const handleStartFill = async () => {
    if (!canStartFill) return

    clearExistingPoll()
    setJobStatus('queued')
    setJobId('')
    setJobError('')
    setFilledFormUrl('')

    try {
      const formUrlSnapshot = formUrl
      const response = await apiFetch('/api/form-fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, formUrl }),
      })

      setJobId(response.jobId)
      setJobStatus(response.status)
      setFilledFormUrl(response.filledFormUrl ?? '')

      if (response.status === 'complete') {
        return
      }

      if (response.status === 'error') {
        setJobError('Pipeline reported an error.')
        return
      }

      scheduleJobPoll(response.jobId, formUrlSnapshot)
    } catch (error) {
      setJobStatus('error')
      setJobError(error.message || 'Failed to start form filling')
    }
  }

  const renderStatusChip = (file) => {
    if (file.deleting) {
      return <Chip size="small" label="Deleting" color="warning" />
    }

    const label = statusLabelMap[file.status] ?? file.status
    const color = file.status === 'uploaded' ? 'success' : file.status === 'error' ? 'error' : 'info'
    const variant = file.status === 'uploaded' ? 'outlined' : 'filled'
    return <Chip size="small" label={label} color={color} variant={variant} />
  }

  const showFileProgress = (file) => file.deleting || file.status === 'uploading' || file.status === 'processing'

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: (theme) => theme.palette.grey[100],
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: { xs: 2, md: 4 },
      }}
    >
      <CssBaseline />
      <Container maxWidth="md">
        <Paper elevation={6} sx={{ p: { xs: 3, md: 5 }, borderRadius: 4 }}>
          <Stack spacing={4}>
            <Stack spacing={1}>
              <Typography variant="h4" fontWeight={600} textAlign="center">
                PDF Form Fill MVP
              </Typography>
              <Typography variant="body2" color="text.secondary" textAlign="center">
                Upload supporting documents, capture the target form link, and trigger the filling pipeline once
                everything is ready. Session ID {userId} keeps your assets grouped in S3.
              </Typography>
            </Stack>

            <TextField
              label="Target form link"
              placeholder="https://s3.amazonaws.com/forms/blank.pdf"
              type="url"
              fullWidth
              value={formUrl}
              onChange={(event) => setFormUrl(event.target.value)}
              error={Boolean(formUrl) && !formUrlIsValid}
              helperText={
                !formUrlIsValid && formUrl
                  ? 'Enter a valid HTTPS link to the blank form.'
                  : 'Public link to the blank PDF form users need filled.'
              }
            />

            <Divider />

            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" spacing={1}>
                <Typography variant="h6">Supporting documents</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Tooltip title="Upload PDFs or images one at a time (16 MB cap)">
                    <span>
                      <Button component="label" startIcon={<CloudUploadIcon />} variant="contained" color="primary">
                        Upload Files
                        <input type="file" hidden multiple onChange={handleFilesSelected} />
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title="Fetch the latest data from the backend">
                    <span>
                      <Button
                        variant="outlined"
                        color="secondary"
                        startIcon={<RefreshOutlinedIcon />}
                        onClick={handleRefreshUploads}
                        disabled={manifestLoading}
                      >
                        Refresh
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Files upload immediately and include the form link once you provide it. Add the link before starting the
                fill job.
              </Typography>

              {manifestError && <Alert severity="warning">{manifestError}</Alert>}

              {files.length === 0 ? (
                manifestLoading ? (
                  <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', borderStyle: 'dashed' }}>
                    <Typography color="text.secondary">Loading your saved files...</Typography>
                  </Paper>
                ) : (
                  <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', borderStyle: 'dashed' }}>
                    <Typography color="text.secondary">No uploads yet. Add files to kick things off.</Typography>
                  </Paper>
                )
              ) : (
                <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {files.map((file) => (
                    <Paper key={file.id} variant="outlined" sx={{ borderColor: 'divider' }}>
                      <ListItem
                        secondaryAction={
                          <Stack direction="row" spacing={1} alignItems="center">
                            {file.s3Url ? (
                              <MuiLink href={file.s3Url} target="_blank" rel="noopener" underline="hover">
                                <Stack direction="row" spacing={0.5} alignItems="center">
                                  <Typography variant="body2">View on S3</Typography>
                                  <LaunchIcon fontSize="small" />
                                </Stack>
                              </MuiLink>
                            ) : (
                              <Chip size="small" label="Pending link" variant="outlined" />
                            )}
                            <Tooltip title="Delete file">
                              <span>
                                <IconButton
                                  edge="end"
                                  color="error"
                                  disabled={file.deleting}
                                  onClick={() => handleDelete(file)}
                                >
                                  <DeleteOutlineIcon />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </Stack>
                        }
                      >
                        <ListItemIcon>
                          <InsertDriveFileOutlinedIcon
                            color={file.status === 'uploaded' ? 'primary' : file.status === 'error' ? 'error' : 'action'}
                          />
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="subtitle1">{file.name}</Typography>
                              {renderStatusChip(file)}
                            </Stack>
                          }
                          secondary={
                            <Stack spacing={0.5}>
                              <Typography variant="body2" color="text.secondary">
                                {formatBytes(file.size)} • {file.slug ? 'Stored in S3' : 'Preparing upload'}
                              </Typography>
                              {file.error && (
                                <Typography variant="body2" color="error.main">
                                  {file.error}
                                </Typography>
                              )}
                            </Stack>
                          }
                        />
                      </ListItem>
                      {showFileProgress(file) && <LinearProgress color="info" />}
                    </Paper>
                  ))}
                </List>
              )}
            </Stack>

            <Divider />

            <Stack spacing={2}>
              <Typography variant="h6">Form filling pipeline</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }}>
                <Button
                  variant="contained"
                  size="large"
                  startIcon={<PlayCircleOutlineIcon />}
                  disabled={!canStartFill}
                  onClick={handleStartFill}
                >
                  Start Form Fill
                </Button>
                <Chip
                  label={jobStatusLabel[jobStatus] ?? jobStatus}
                  color={jobStatusColor[jobStatus] ?? 'default'}
                />
              </Stack>

              {jobId && (
                <Typography variant="caption" color="text.secondary">
                  Job ID: {jobId}
                </Typography>
              )}

              {(jobStatus === 'queued' || jobStatus === 'filling') && <LinearProgress color="info" />}

              {jobError && <Alert severity="error">{jobError}</Alert>}

              {filledFormUrl && jobStatus === 'complete' && (
                <Alert severity="success">
                  Filled form ready.{' '}
                  <MuiLink href={filledFormUrl} target="_blank" rel="noopener" underline="hover">
                    Open filled PDF
                  </MuiLink>
                </Alert>
              )}
            </Stack>
          </Stack>
        </Paper>
      </Container>
    </Box>
  )
}

export default App
