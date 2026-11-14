using Ferry.Ops.Routes;

namespace Ferry.Ops.Controllers;

[Route("ops")]
public class HealthController : ControllerBase
{
    [HttpGet(OpsRoutes.Ping)]
    public IActionResult Ping()
    {
        return Ok();
    }
}
