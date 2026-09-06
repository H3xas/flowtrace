using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace GizmoShop.Api.Controllers
{
    [ApiController]
    [Route("gizmos/v1")]
    public class GizmoController : ControllerBase
    {
        private readonly IGizmoService _gizmos;

        public GizmoController(IGizmoService gizmos)
        {
            _gizmos = gizmos;
        }

        [HttpGet("catalog")]
        public async Task<IActionResult> GetCatalog()
        {
            var catalog = await _gizmos.GetCatalog();
            return Ok(catalog);
        }

        [HttpPost("activate")]
        public async Task<IActionResult> Activate([FromBody] ActivateGizmoRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.SerialCode))
            {
                return BadRequest("serialCode is required");
            }

            var activated = await _gizmos.Activate(request.SerialCode);
            if (!activated)
            {
                return Forbid();
            }

            return Ok();
        }
    }
}
