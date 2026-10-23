using Ferry.Api.Services;

namespace Ferry.Api.Controllers;

[ApiController]
[Route("sailings")]
public class SailingsController : ControllerBase
{
    private readonly Timetable _timetable;

    public SailingsController(Timetable timetable)
    {
        _timetable = timetable;
    }

    [HttpGet("{id}")]
    [Tags([
        "sailings",
        "public"])]
    public IActionResult GetSailing(int id)
    {
        return Ok(_timetable.Find(id));
    }

    [HttpGet("{id}/stops")]
    [ProducesResponseType(
        typeof(StopList),
        200)]
    [SwaggerOperation(
        Summary = "Stops of one sailing",
        Description = "Every port the sailing calls at")]
    public IActionResult GetStops(int id)
    {
        return Ok(_timetable.Stops(id));
    }

    [HttpPost("upload")]
    [RequestSizeLimit(1_000_000)] // 1 MB
    public IActionResult Upload(UploadRequest request)
    {
        return Ok(_timetable.Import(request));
    }
}
